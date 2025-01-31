import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
  BatchGetCommand,
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
const TIME_ZONE = "Asia/Tokyo";
const SENDING_START_HOUR = parseInt(process.env.SENDING_START_HOUR || "0", 10);
const SENDING_END_HOUR = parseInt(process.env.SENDING_END_HOUR || "24", 10);

function getJSTDate(date = new Date()) {
  return new Date(date.toLocaleString("en-US", { timeZone: TIME_ZONE }));
}

function isWithinSendingHours() {
  const now = getJSTDate();
  const hour = now.getHours();
  return hour >= SENDING_START_HOUR && hour < SENDING_END_HOUR;
}

export const handler = async (event) => {
  console.log("Starting sendReminderEmails function");

  if (!isWithinSendingHours()) {
    console.log(
      `Outside of sending hours (${SENDING_START_HOUR}:00-${SENDING_END_HOUR}:00). Exiting.`
    );
    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Outside of sending hours" }),
    };
  }

  try {
    const schedules = await getUpcomingSchedules();

    if (schedules.length === 0) {
      console.log("No upcoming schedules found. Exiting.");
      return {
        statusCode: 200,
        body: JSON.stringify({ message: "No reminders to send" }),
      };
    }

    const performanceIds = [...new Set(schedules.map((s) => s.performanceId))];
    const performances = await getPerformances(performanceIds);
    const template = await getEmailTemplate("reminder-email");

    let sentCount = 0;
    let errorCount = 0;

    for (const schedule of schedules) {
      const reservations = await getReservationsForSchedule(
        schedule.performanceId,
        schedule.id
      );

      const performance = performances.find(
        (p) => p.id === schedule.performanceId
      );

      const emailPromises = reservations.map(async (reservation) => {
        if (!reservation.reminderEmailSent && schedule.entryUrl) {
          try {
            await sendReminderEmail(
              reservation,
              schedule,
              performance,
              template
            );
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
      });

      await Promise.all(emailPromises);
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
  const now = getJSTDate();
  const tomorrow = getJSTDate(now);
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

async function sendReminderEmail(reservation, schedule, performance, template) {
  const performanceDate = getJSTDate(new Date(schedule.date));
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

async function getPerformances(performanceIds) {
  const command = new BatchGetCommand({
    RequestItems: {
      [PERFORMANCES_TABLE_NAME]: {
        Keys: performanceIds.map((id) => ({ id })),
      },
    },
  });

  const result = await dynamodb.send(command);
  return result.Responses[PERFORMANCES_TABLE_NAME];
}
