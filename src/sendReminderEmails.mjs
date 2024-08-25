import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { sendNotification } from "./utils/notification.js";

const dynamoClient = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);
const sesClient = new SESClient({ region: process.env.AWS_REGION });
const s3Client = new S3Client({ region: process.env.AWS_REGION });

const RESERVATIONS_TABLE_NAME = process.env.RESERVATIONS_TABLE_NAME;
const SCHEDULES_TABLE_NAME = process.env.SCHEDULES_TABLE_NAME;
const PERFORMANCES_TABLE_NAME = process.env.PERFORMANCES_TABLE_NAME;
const SENDER_EMAIL = process.env.SENDER_EMAIL;
const TEMPLATE_BUCKET = process.env.TEMPLATE_BUCKET;

export const handler = async (event) => {
  console.log("Starting sendReminderEmails function");

  try {
    const schedules = await getUpcomingSchedules();
    let sentCount = 0;
    let errorCount = 0;

    for (const schedule of schedules) {
      const reservations = await getReservationsForSchedule(
        schedule.performanceId,
        schedule.id
      );

      for (const reservation of reservations) {
        if (!reservation.reminderEmailSent && schedule.entryUrl) {
          try {
            await sendReminderEmail(reservation, schedule);
            await updateReservationReminderSent(reservation.id);
            sentCount++;
          } catch (error) {
            console.error(
              `Error sending reminder email for reservation ${reservation.id}:`,
              error
            );
            errorCount++;
          }
        }
      }
    }

    const resultMessage = `リマインドメール送信: 成功 ${sentCount}件, エラー ${errorCount}件`;
    console.log(resultMessage);
    if (sentCount > 0 || errorCount > 0) {
      await sendNotification(
        resultMessage,
        "INFO",
        errorCount > 0 ? "MEDIUM" : "LOW",
        "sendReminderEmails"
      );
    }
    return {
      statusCode: 200,
      body: JSON.stringify({ message: resultMessage }),
    };
  } catch (error) {
    console.error("リマインドメール送信エラー: ", error);
    const errorMessage = error.message || JSON.stringify(error);
    await sendNotification(
      `リマインドメール送信エラー: ${errorMessage}`,
      "ERROR",
      "HIGH",
      "sendReminderEmails"
    );
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Failed to send reminder emails",
        details: errorMessage,
      }),
    };
  }
};

async function getUpcomingSchedules() {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const today = now.toISOString().split("T")[0];
  const tomorrowDate = tomorrow.toISOString().split("T")[0];

  const todayCommand = new QueryCommand({
    TableName: SCHEDULES_TABLE_NAME,
    IndexName: "DateIndex",
    KeyConditionExpression: "#date = :date",
    ExpressionAttributeNames: {
      "#date": "date",
    },
    ExpressionAttributeValues: {
      ":date": today,
    },
  });

  const tomorrowCommand = new QueryCommand({
    TableName: SCHEDULES_TABLE_NAME,
    IndexName: "DateIndex",
    KeyConditionExpression: "#date = :date",
    ExpressionAttributeNames: {
      "#date": "date",
    },
    ExpressionAttributeValues: {
      ":date": tomorrowDate,
    },
  });

  const [todayResult, tomorrowResult] = await Promise.all([
    dynamodb.send(todayCommand),
    dynamodb.send(tomorrowCommand),
  ]);

  return [...(todayResult.Items || []), ...(tomorrowResult.Items || [])];
}

async function getReservationsForSchedule(performanceId, scheduleId) {
  const command = new QueryCommand({
    TableName: RESERVATIONS_TABLE_NAME,
    IndexName: "GSI1",
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
  });

  const result = await dynamodb.send(command);
  return result.Items;
}

async function sendReminderEmail(reservation, schedule) {
  const template = await getEmailTemplate("reminder-email");
  const performance = await getPerformance(schedule.performanceId);

  const performanceDate = new Date(schedule.date);
  const dayOfWeek = ["日", "月", "火", "水", "木", "金", "土"][
    performanceDate.getDay()
  ];
  const formattedDate = `${schedule.date.replace(/-/g, "/")} (${dayOfWeek}) ${
    schedule.time
  }`;

  const emailBody = template
    .replaceAll("{{name}}", reservation.name)
    .replace("{{performanceTitle}}", performance.title)
    .replace("{{performanceDateTime}}", formattedDate)
    .replace("{{reservedSeats}}", reservation.reservedSeats)
    .replace(
      "{{eventPageUrl}}",
      `${process.env.FRONTEND_URL}/events/${performance.id}`
    )
    .replace("{{entryUrl}}", schedule.entryUrl);

  const params = {
    Destination: { ToAddresses: [reservation.email] },
    Message: {
      Body: { Text: { Data: emailBody } },
      Subject: { Data: "【ましろ小劇場】公演のご案内" },
    },
    Source: SENDER_EMAIL,
  };

  await sesClient.send(new SendEmailCommand(params));
}

async function updateReservationReminderSent(reservationId) {
  const command = new UpdateCommand({
    TableName: RESERVATIONS_TABLE_NAME,
    Key: { id: reservationId },
    UpdateExpression: "SET reminderEmailSent = :sent",
    ExpressionAttributeValues: {
      ":sent": true,
    },
  });

  await dynamodb.send(command);
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

async function getPerformance(performanceId) {
  const command = new QueryCommand({
    TableName: PERFORMANCES_TABLE_NAME,
    KeyConditionExpression: "id = :pid",
    ExpressionAttributeValues: {
      ":pid": performanceId,
    },
  });

  const result = await dynamodb.send(command);
  return result.Items[0];
}
