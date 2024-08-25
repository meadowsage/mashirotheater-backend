import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "crypto";
import { sendNotification } from "./utils/notification.js";

const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);
const sesClient = new SESClient({ region: process.env.SES_REGION });
const ssmClient = new SSMClient({ region: process.env.AWS_REGION });
const s3Client = new S3Client({ region: process.env.AWS_REGION });

const RESERVATIONS_TABLE_NAME = process.env.RESERVATIONS_TABLE_NAME;
const PERFORMANCES_TABLE_NAME = process.env.PERFORMANCES_TABLE_NAME;
const SCHEDULES_TABLE_NAME = process.env.SCHEDULES_TABLE_NAME;
const STAGE = process.env.STAGE;
const FRONTEND_URL = process.env.FRONTEND_URL;
const SENDER_EMAIL = process.env.SENDER_EMAIL;
const TEMPLATE_BUCKET = process.env.TEMPLATE_BUCKET;
const RESERVATION_EXPIRATION_HOURS = 1; // 予約の有効期限（時間）

async function getSecretKey() {
  const parameterName = `/${STAGE}/mashirotheater/reservation/secret-key`;
  const command = new GetParameterCommand({
    Name: parameterName,
    WithDecryption: true,
  });
  const response = await ssmClient.send(command);
  return response.Parameter.Value;
}

export const handler = async (event) => {
  console.log("Received event:", JSON.stringify(event, null, 2));

  const { id, token } = event.queryStringParameters;

  try {
    // 予約情報の取得
    const reservation = await getReservation(id);
    if (!reservation) {
      return redirectToFrontend("not-found");
    }

    // 有効期限のチェック
    const expirationTime = new Date(
      Date.now() - RESERVATION_EXPIRATION_HOURS * 60 * 60 * 1000
    ).toISOString();
    if (reservation.createdAt < expirationTime) {
      await updateReservationStatus(id, "expired");
      return redirectToFrontend("expired", reservation.performanceId);
    }

    // トークンの検証
    const SECRET_KEY = await getSecretKey();
    const calculatedHash = createHash("sha256")
      .update(`${id}${reservation.email}${SECRET_KEY}`)
      .digest("hex");

    if (token !== calculatedHash) {
      return redirectToFrontend("invalid", reservation.performanceId);
    }

    // 予約済かの確認
    if (reservation.status === "confirmed") {
      return redirectToFrontend("already-confirmed", reservation.performanceId);
    }

    // 残席の確認と予約の確定
    const confirmationResult = await confirmReservation(reservation);
    if (!confirmationResult.success) {
      return redirectToFrontend("no-seats", reservation.performanceId);
    }

    // 予約詳細の取得
    const performanceDetails = await getPerformanceDetails(
      reservation.performanceId,
      reservation.scheduleId
    );

    // 確認メールの送信
    await sendConfirmationEmail(reservation, performanceDetails);

    await sendNotification(
      `予約確定: ID ${id}`,
      "INFO",
      "LOW",
      "confirmReservation"
    );
    return redirectToFrontend("success", reservation.performanceId);
  } catch (error) {
    await sendNotification(
      `予約確定エラー: ${error.message}`,
      "ERROR",
      "HIGH",
      "confirmReservation"
    );
    console.error("Error:", error);
    return redirectToFrontend("error", null);
  }
};

async function confirmReservation(reservation) {
  // 現在の残席数を取得
  const availableSeats = await getAvailableSeats(
    reservation.performanceId,
    reservation.scheduleId
  );

  if (availableSeats < reservation.reservedSeats) {
    return { success: false };
  }

  // トランザクションを使用して予約を確定する
  const transactItems = [
    {
      Update: {
        TableName: RESERVATIONS_TABLE_NAME,
        Key: { id: reservation.id },
        UpdateExpression: "SET #status = :status, updatedAt = :updatedAt",
        ExpressionAttributeNames: {
          "#status": "status",
        },
        ExpressionAttributeValues: {
          ":status": "confirmed",
          ":updatedAt": new Date().toISOString(),
        },
      },
    },
  ];

  try {
    await dynamodb.send(
      new TransactWriteCommand({ TransactItems: transactItems })
    );
    return { success: true };
  } catch (error) {
    console.error("Error confirming reservation:", error);
    return { success: false };
  }
}

async function getAvailableSeats(performanceId, scheduleId) {
  // スケジュールの総座席数を取得
  const scheduleCommand = new GetCommand({
    TableName: SCHEDULES_TABLE_NAME,
    Key: { performanceId, id: scheduleId },
  });
  const scheduleResult = await dynamodb.send(scheduleCommand);
  const totalSeats = scheduleResult.Item.totalSeats;

  // 確定済みの予約座席数を取得
  const reservationsCommand = new QueryCommand({
    TableName: RESERVATIONS_TABLE_NAME,
    IndexName: "GSI1", // GSI1 インデックスを使用
    KeyConditionExpression: "performanceId = :pid AND scheduleId = :sid",
    FilterExpression: "#status = :status",
    ExpressionAttributeNames: {
      "#status": "status",
    },
    ExpressionAttributeValues: {
      ":pid": performanceId,
      ":sid": scheduleId,
      ":status": "confirmed",
    },
    ProjectionExpression: "reservedSeats",
  });

  const reservationsResult = await dynamodb.send(reservationsCommand);
  const reservedSeats = reservationsResult.Items.reduce(
    (total, item) => total + item.reservedSeats,
    0
  );

  return totalSeats - reservedSeats;
}

async function updateReservationStatus(reservationId, status) {
  const command = new UpdateCommand({
    TableName: RESERVATIONS_TABLE_NAME,
    Key: { id: reservationId },
    UpdateExpression: "SET #status = :status, updatedAt = :updatedAt",
    ExpressionAttributeNames: {
      "#status": "status",
    },
    ExpressionAttributeValues: {
      ":status": status,
      ":updatedAt": new Date().toISOString(),
    },
  });

  await dynamodb.send(command);
}

async function getReservation(reservationId) {
  const command = new GetCommand({
    TableName: RESERVATIONS_TABLE_NAME,
    Key: { id: reservationId },
  });

  const result = await dynamodb.send(command);
  return result.Item;
}

async function getPerformanceDetails(performanceId, scheduleId) {
  const performanceCommand = new GetCommand({
    TableName: PERFORMANCES_TABLE_NAME,
    Key: { id: performanceId },
  });

  const scheduleCommand = new GetCommand({
    TableName: SCHEDULES_TABLE_NAME,
    Key: { performanceId, id: scheduleId },
  });

  const [performanceResult, scheduleResult] = await Promise.all([
    dynamodb.send(performanceCommand),
    dynamodb.send(scheduleCommand),
  ]);

  return {
    title: performanceResult.Item.title,
    date: scheduleResult.Item.date,
    time: scheduleResult.Item.time,
    performanceId: performanceId,
  };
}

async function sendConfirmationEmail(reservation, performanceDetails) {
  const template = await getEmailTemplate("reservation-confirmed");

  const dayOfWeek = ["日", "月", "火", "水", "木", "金", "土"][
    new Date(performanceDetails.date).getDay()
  ];
  const formattedDate = `${performanceDetails.date.replace(
    /-/g,
    "/"
  )} (${dayOfWeek}) ${performanceDetails.time}`;

  const cancelToken = createHash("sha256")
    .update(`${reservation.id}${await getSecretKey()}`)
    .digest("hex");

  const cancelUrl = `${FRONTEND_URL}/reservations/cancel?id=${reservation.id}&token=${cancelToken}`;
  const eventPageUrl = `${FRONTEND_URL}/events/${performanceDetails.performanceId}`;

  const emailBody = template
    .replaceAll("{{name}}", reservation.name)
    .replace("{{performanceTitle}}", performanceDetails.title)
    .replace("{{performanceDateTime}}", formattedDate)
    .replace("{{reservedSeats}}", reservation.reservedSeats)
    .replace("{{eventPageUrl}}", eventPageUrl)
    .replace("{{cancelUrl}}", cancelUrl);

  const params = {
    Destination: { ToAddresses: [reservation.email] },
    Message: {
      Body: { Text: { Data: emailBody } },
      Subject: { Data: "【ましろ小劇場】ご予約が確定いたしました" },
    },
    Source: SENDER_EMAIL,
  };

  await sesClient.send(new SendEmailCommand(params));
}

async function getEmailTemplate(templateName) {
  const command = new GetObjectCommand({
    Bucket: TEMPLATE_BUCKET,
    Key: `email-templates/${templateName}.txt`,
  });

  const response = await s3Client.send(command);
  return streamToString(response.Body);
}

function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function redirectToFrontend(status, performanceId = null) {
  let url = `${FRONTEND_URL}/reservations/result?status=${status}`;
  if (performanceId) {
    url += `&performanceId=${performanceId}`;
  }
  return {
    statusCode: 302,
    headers: {
      Location: url,
    },
  };
}
