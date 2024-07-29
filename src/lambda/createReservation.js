import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const sesClient = new SESClient({ region: process.env.SES_REGION });

const RESERVATIONS_TABLE_NAME = process.env.RESERVATIONS_TABLE_NAME;
const SCHEDULES_TABLE_NAME = process.env.SCHEDULES_TABLE_NAME;
const SENDER_EMAIL = process.env.SENDER_EMAIL;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN; // 例: 'http://localhost:3000'

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
};

export const handler = async (event) => {
  // Preflight OPTIONSリクエストの処理
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ message: 'CORS preflight request successful' })
    };
  }

  console.log("Received event:", JSON.stringify(event, null, 2));

  try {
    const { performanceId, scheduleId, name, email, reservedSeats, notes } = JSON.parse(event.body);

    if (!performanceId || !scheduleId || !name || !email || (reservedSeats <= 0 && reservedSeats > 4)) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ message: "Missing required fields" })
      };
    }

    // 予約可能かチェック
    const availableSeats = await getAvailableSeats(performanceId, scheduleId);
    if (availableSeats - reservedSeats < 0) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ message: "No available seats" })
      };
    }

    // 予約を作成
    const reservationId = generateReservationId();
    const confirmationCode = generateConfirmationCode();
    // 予約オブジェクトの作成
    const reservation = {
      reservationId,
      performanceId,
      scheduleId,
      name,
      email,
      reservedSeats,
      notes,
      confirmationCode,
      status: 'pending',
      createdAt: new Date().toISOString()
    };

    await createReservation(reservation);

    // 確認メールを送信
    await sendConfirmationEmail(email, name, confirmationCode, { performanceId, scheduleId });

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ 
        message: "Reservation created successfully",
        reservationId,
        confirmationCode
      })
    };

  } catch (error) {
    console.error("Error:", error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ message: "Internal server error" })
    };
  }
};

async function getAvailableSeats(performanceId, scheduleId) {
  const command = new GetCommand({
    TableName: SCHEDULES_TABLE_NAME,
    Key: {
      performanceId,
      id: scheduleId
    }
  });

  const result = await docClient.send(command);
  const schedule = result.Item;

  if (!schedule) {
    throw new Error("Schedule not found");
  }

  const reservedSeats = await getReservedSeatsCount(performanceId, scheduleId);
  return schedule.totalSeats - reservedSeats;
}

// 残席計算の関数内で使用
async function getReservedSeatsCount(performanceId, scheduleId) {
  const command = new QueryCommand({
    TableName: RESERVATIONS_TABLE_NAME,
    KeyConditionExpression: "performanceId = :pid AND scheduleId = :sid",
    ExpressionAttributeValues: {
      ":pid": performanceId,
      ":sid": scheduleId
    }
  });

  const result = await docClient.send(command);
  return result.Items.reduce((total, item) => total + (item.reservedSeats || 1), 0);
}

async function createReservation(reservation) {
  const command = new PutCommand({
    TableName: RESERVATIONS_TABLE_NAME,
    Item: reservation
  });

  await docClient.send(command);
}

function generateReservationId() {
  return `RES${Date.now()}${Math.random().toString(36).substr(2, 5)}`;
}

function generateConfirmationCode() {
  return Math.random().toString(36).substr(2, 8).toUpperCase();
}

async function sendConfirmationEmail(email, name, confirmationCode, performanceDetails) {
  const params = {
    Destination: {
      ToAddresses: [email],
    },
    Message: {
      Body: {
        Text: {
          Charset: "UTF-8",
          Data: `親愛なる${name}様,\n\n
ご予約ありがとうございます。以下の予約内容をご確認ください：\n
公演ID：${performanceDetails.performanceId}\n
スケジュールID：${performanceDetails.scheduleId}\n
予約確認コード：${confirmationCode}\n\n
予約を確定するには、以下のリンクをクリックしてください：\n
https://yourwebsite.com/confirm-reservation?code=${confirmationCode}\n\n
ご質問がございましたら、お気軽にお問い合わせください。\n
ご来場をお待ちしております。`,
        },
      },
      Subject: {
        Charset: "UTF-8",
        Data: "予約確認 - マシロ小劇場",
      },
    },
    Source: SENDER_EMAIL,
  };

  try {
    const command = new SendEmailCommand(params);
    const response = await sesClient.send(command);
    console.log("Email sent successfully:", response.MessageId);
    return response.MessageId;
  } catch (error) {
    console.error("Error sending email:", error);
    throw error;
  }
}