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

// 追加: Attendeesテーブル
const RESERVATIONS_TABLE_NAME = process.env.RESERVATIONS_TABLE_NAME;
const ATTENDEES_TABLE_NAME = process.env.ATTENDEES_TABLE_NAME; // ← Here
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
  console.log("Starting sendSurveyEmails function");

  if (!isWithinSendingHours()) {
    console.log("Outside of sending hours. Exiting.");
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Outside of sending hours",
      }),
    };
  }

  try {
    const schedules = await getPastSchedules();

    if (schedules.length === 0) {
      console.log("No past schedules found. Exiting.");
      return {
        statusCode: 200,
        body: JSON.stringify({ message: "No surveys to send" }),
      };
    }

    const performanceIds = [...new Set(schedules.map((s) => s.performanceId))];
    const performances = await getPerformances(performanceIds);
    const template = await getEmailTemplate("survey-email");

    let sentCount = 0;
    let errorCount = 0;

    for (const schedule of schedules) {
      const performance = performances.find(
        (p) => p.id === schedule.performanceId
      );

      // 公演に surveyFormUrl が無ければスキップ
      if (!performance || !performance.surveyFormUrl) {
        console.log(
          `Skipping schedule ${schedule.id}: No performance found or no survey URL`
        );
        continue;
      }

      const reservations = await getConfirmedReservationsForSchedule(
        schedule.performanceId,
        schedule.id
      );

      const emailPromises = reservations.map(async (reservation) => {
        if (!reservation.surveyEmailSent) {
          try {
            // 代表者が参加済(checkedIn)かどうか判定
            const checkedIn = await isRepresentativeCheckedIn(reservation);
            if (!checkedIn) {
              // 代表者がチェックインしていない → アンケート送信しない
              return;
            }

            await sendSurveyEmail(reservation, schedule, performance, template);
            await updateReservationSurveySent(reservation.id);
            sentCount++;
          } catch (error) {
            console.error(
              `Error sending survey email for reservation ${reservation.id}:`,
              error
            );
            errorCount++;
          }
        }
      });

      await Promise.all(emailPromises);
    }

    const resultMessage = `アンケートメール送信: 成功 ${sentCount}件, エラー ${errorCount}件`;
    console.log(resultMessage);
    if (sentCount > 0 || errorCount > 0) {
      await sendNotification(
        resultMessage,
        "INFO",
        errorCount > 0 ? "MEDIUM" : "LOW",
        "sendSurveyEmails"
      );
    }
    return {
      statusCode: 200,
      body: JSON.stringify({ message: resultMessage }),
    };
  } catch (error) {
    console.error("アンケートメール送信エラー: ", error);
    const errorMessage = error.message || JSON.stringify(error);
    await sendNotification(
      `アンケートメール送信エラー: ${errorMessage}`,
      "ERROR",
      "HIGH",
      "sendSurveyEmails"
    );
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Failed to send survey emails",
        details: errorMessage,
      }),
    };
  }
};

/** 1日前のスケジュールを取得 (Index: DateIndex) */
async function getPastSchedules() {
  const yesterday = getJSTDate();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayDate = yesterday.toISOString().split("T")[0];

  const command = new QueryCommand({
    TableName: SCHEDULES_TABLE_NAME,
    IndexName: "DateIndex",
    KeyConditionExpression: "#date = :date",
    ExpressionAttributeNames: {
      "#date": "date",
    },
    ExpressionAttributeValues: {
      ":date": yesterdayDate,
    },
  });

  const result = await dynamodb.send(command);
  console.log("Found schedules:", result.Items);
  return result.Items || [];
}

/** スケジュールの confirmed 予約を取得 */
async function getConfirmedReservationsForSchedule(performanceId, scheduleId) {
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
  console.log(
    `Found confirmed reservations for performance ${performanceId}, schedule ${scheduleId}:`,
    result.Items
  );
  return result.Items;
}

/** 代表者がcheckedIn=true か判定 */
async function isRepresentativeCheckedIn(reservation) {
  // occupant i=0 は attendee.name === reservation.name とする想定
  const command = new QueryCommand({
    TableName: ATTENDEES_TABLE_NAME,
    IndexName: "ReservationIdIndex",
    KeyConditionExpression: "reservationId = :rid",
    ExpressionAttributeValues: {
      ":rid": reservation.id,
    },
  });
  const res = await dynamodb.send(command);
  const attendees = res.Items || [];

  const mainAttendee = attendees.find((att) => att.name === reservation.name);
  if (!mainAttendee) {
    // occupant i=0 not found => false
    return false;
  }

  return mainAttendee.checkedIn === true;
}

/** Surveyメール送信 */
async function sendSurveyEmail(reservation, schedule, performance, template) {
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
    .replace("{{surveyFormUrl}}", performance.surveyFormUrl);

  const params = {
    Destination: { ToAddresses: [reservation.email] },
    Message: {
      Body: { Text: { Data: emailBody } },
      Subject: { Data: "【ましろ小劇場】公演アンケートへのご協力のお願い" },
    },
    Source: SENDER_EMAIL,
  };

  await sesClient.send(new SendEmailCommand(params));
}

/** reservation.surveyEmailSent=true に更新 */
async function updateReservationSurveySent(reservationId) {
  const command = new UpdateCommand({
    TableName: RESERVATIONS_TABLE_NAME,
    Key: { id: reservationId },
    UpdateExpression: "SET surveyEmailSent = :sent",
    ExpressionAttributeValues: {
      ":sent": true,
    },
  });

  await dynamodb.send(command);
}

/** メールテンプレート読み込み */
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

/** Performancesをまとめて取得 */
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
