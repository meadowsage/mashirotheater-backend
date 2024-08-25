import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "crypto";

const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);
const sesClient = new SESClient({ region: process.env.SES_REGION });
const ssmClient = new SSMClient({ region: process.env.AWS_REGION });
const s3Client = new S3Client({ region: process.env.AWS_REGION });

const PERFORMANCES_TABLE_NAME = process.env.PERFORMANCES_TABLE_NAME;
const SCHEDULES_TABLE_NAME = process.env.SCHEDULES_TABLE_NAME;
const RESERVATIONS_TABLE_NAME = process.env.RESERVATIONS_TABLE_NAME;
const SENDER_EMAIL = process.env.SENDER_EMAIL;
const STAGE = process.env.STAGE;
const CONFIRMATION_URL = process.env.CONFIRMATION_URL;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS.split(",");

const corsHeaders = {
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
};

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

  const origin = ALLOWED_ORIGINS.includes(event.headers.origin)
    ? event.headers.origin
    : ALLOWED_ORIGINS[0];

  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        "Access-Control-Allow-Origin": origin,
      },
      body: JSON.stringify({ message: "CORS preflight request successful" }),
    };
  }

  try {
    const { performanceId, scheduleId, name, email, reservedSeats, notes } =
      JSON.parse(event.body);

    if (
      !performanceId ||
      !scheduleId ||
      !name ||
      !email ||
      reservedSeats <= 0
    ) {
      return createErrorResponse(
        400,
        "E002",
        "Missing required fields or invalid seat count",
        origin
      );
    }

    // 公演データの取得
    const performance = await getPerformance(performanceId);
    if (!performance) {
      return createResponse(404, { message: "Performance not found" }, origin);
    }

    // 予約開始時間のチェック
    const reservationStartTime = new Date(performance.reservationStartTime);
    if (new Date() < reservationStartTime) {
      return createResponse(
        403,
        {
          message: "Reservations are not yet open",
          reservationStartTime: performance.reservationStartTime,
        },
        origin
      );
    }

    // 予約重複チェック
    const reservationCheck = await checkExistingReservation(
      performanceId,
      scheduleId,
      email
    );
    if (!reservationCheck.allowed) {
      let errorCode, errorMessage;
      if (reservationCheck.reason === "SAME_SCHEDULE") {
        errorCode = "E004";
        errorMessage =
          "A reservation already exists for this schedule and email address";
      } else if (reservationCheck.reason === "MAX_PERFORMANCE_REACHED") {
        errorCode = "E005";
        errorMessage =
          "Maximum number of reservations reached for this performance";
      }
      return createErrorResponse(400, errorCode, errorMessage, origin);
    }

    const availableSeats = await getAvailableSeats(performanceId, scheduleId);
    if (availableSeats < reservedSeats) {
      return createErrorResponse(
        400,
        "E001",
        "Not enough available seats",
        origin
      );
    }

    const reservationId = generateReservationId();
    const confirmationCode = generateConfirmationCode();
    const SECRET_KEY = await getSecretKey();
    const tempUrl = generateTemporaryUrl(reservationId, email, SECRET_KEY);

    const now = new Date().toISOString();
    const reservation = {
      id: reservationId,
      performanceId,
      scheduleId,
      name,
      email,
      reservedSeats,
      notes,
      confirmationCode,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };

    await createReservation(reservation);

    const performanceDetails = await getPerformanceDetails(
      performanceId,
      scheduleId
    );
    await sendConfirmationEmail(
      email,
      name,
      tempUrl,
      performanceDetails,
      reservedSeats
    );

    return createResponse(
      200,
      {
        message: "Reservation created successfully",
        reservationId,
        confirmationCode,
      },
      origin
    );
  } catch (error) {
    console.error("Error:", error);
    return createErrorResponse(500, "E999", "Internal server error", origin);
  }
};

async function getPerformance(performanceId) {
  const command = new GetCommand({
    TableName: PERFORMANCES_TABLE_NAME,
    Key: { id: performanceId },
  });
  const result = await dynamodb.send(command);
  return result.Item;
}

function generateReservationId() {
  return `RES${Date.now()}${Math.random().toString(36).substr(2, 6)}`;
}

async function getAvailableSeats(performanceId, scheduleId) {
  const scheduleCommand = new GetCommand({
    TableName: SCHEDULES_TABLE_NAME,
    Key: {
      performanceId: performanceId,
      id: scheduleId,
    },
  });

  const reservationsCommand = new QueryCommand({
    TableName: RESERVATIONS_TABLE_NAME,
    IndexName: "GSI1",
    KeyConditionExpression: "performanceId = :pid AND scheduleId = :sid",
    FilterExpression: "#status IN (:pending, :confirmed)",
    ExpressionAttributeNames: {
      "#status": "status",
    },
    ExpressionAttributeValues: {
      ":pid": performanceId,
      ":sid": scheduleId,
      ":pending": "pending",
      ":confirmed": "confirmed",
    },
    ProjectionExpression: "reservedSeats",
  });

  try {
    const [scheduleResult, reservationsResult] = await Promise.all([
      dynamodb.send(scheduleCommand),
      dynamodb.send(reservationsCommand),
    ]);

    if (!scheduleResult.Item) {
      throw new Error("Schedule not found");
    }

    const totalSeats = scheduleResult.Item.totalSeats;
    const reservedSeats = reservationsResult.Items.reduce(
      (total, item) => total + item.reservedSeats,
      0
    );

    return totalSeats - reservedSeats;
  } catch (error) {
    console.error("Error fetching available seats:", error);
    throw error;
  }
}

async function createReservation(reservation) {
  const command = new PutCommand({
    TableName: RESERVATIONS_TABLE_NAME,
    Item: {
      ...reservation,
      status: "pending",
    },
    ConditionExpression: "attribute_not_exists(id)",
  });

  await dynamodb.send(command);
}

function generateConfirmationCode() {
  return Math.random().toString(36).substr(2, 8).toUpperCase();
}

function generateTemporaryUrl(reservationId, email, secretKey) {
  const hash = createHash("sha256")
    .update(`${reservationId}${email}${secretKey}`)
    .digest("hex");
  return `${CONFIRMATION_URL}?id=${reservationId}&token=${hash}`;
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

  if (!performanceResult.Item || !scheduleResult.Item) {
    throw new Error("Performance or schedule not found");
  }

  return {
    title: performanceResult.Item.title,
    date: scheduleResult.Item.date,
    time: scheduleResult.Item.time,
    performanceId: performanceId,
  };
}

async function sendConfirmationEmail(
  email,
  name,
  tempUrl,
  performanceDetails,
  reservedSeats
) {
  const template = await getEmailTemplate("reservation-confirmation");

  const dayOfWeek = ["日", "月", "火", "水", "木", "金", "土"][
    new Date(performanceDetails.date).getDay()
  ];
  const formattedDate = `${performanceDetails.date.replace(
    /-/g,
    "/"
  )} (${dayOfWeek}) ${performanceDetails.time}`;
  const eventPageUrl = `${process.env.FRONTEND_URL}/events/${performanceDetails.performanceId}`;

  const emailBody = template
    .replaceAll("{{name}}", name)
    .replace("{{confirmationLink}}", tempUrl)
    .replace("{{performanceTitle}}", performanceDetails.title)
    .replace("{{performanceDateTime}}", formattedDate)
    .replace("{{reservedSeats}}", reservedSeats)
    .replace("{{eventPageUrl}}", eventPageUrl);

  const params = {
    Destination: { ToAddresses: [email] },
    Message: {
      Body: { Text: { Data: emailBody } },
      Subject: { Data: "【ましろ小劇場】予約内容のご確認" },
    },
    Source: SENDER_EMAIL,
  };

  await sesClient.send(new SendEmailCommand(params));
}

async function getEmailTemplate(templateName) {
  const command = new GetObjectCommand({
    Bucket: process.env.TEMPLATE_BUCKET,
    Key: `email-templates/${templateName}.txt`,
  });

  const response = await s3Client.send(command);
  return await streamToString(response.Body);
}

function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function checkExistingReservation(performanceId, scheduleId, email) {
  // 同一の日程（ScheduleId）に対する予約をチェック
  const scheduleCommand = new QueryCommand({
    TableName: RESERVATIONS_TABLE_NAME,
    IndexName: "GSI1",
    KeyConditionExpression: "performanceId = :pid AND scheduleId = :sid",
    FilterExpression: "email = :email AND #status IN (:pending, :confirmed)",
    ExpressionAttributeNames: {
      "#status": "status",
    },
    ExpressionAttributeValues: {
      ":pid": performanceId,
      ":sid": scheduleId,
      ":email": email,
      ":pending": "pending",
      ":confirmed": "confirmed",
    },
  });

  // 同一の公演（PerformanceId）に対する予約をチェック
  const performanceCommand = new QueryCommand({
    TableName: RESERVATIONS_TABLE_NAME,
    IndexName: "GSI1",
    KeyConditionExpression: "performanceId = :pid",
    FilterExpression: "email = :email AND #status IN (:pending, :confirmed)",
    ExpressionAttributeNames: {
      "#status": "status",
    },
    ExpressionAttributeValues: {
      ":pid": performanceId,
      ":email": email,
      ":pending": "pending",
      ":confirmed": "confirmed",
    },
  });

  const [scheduleResult, performanceResult] = await Promise.all([
    dynamodb.send(scheduleCommand),
    dynamodb.send(performanceCommand),
  ]);

  const sameScheduleReservations = scheduleResult.Items.length;
  const samePerformanceReservations = performanceResult.Items.length;

  if (sameScheduleReservations > 0) {
    return { allowed: false, reason: "SAME_SCHEDULE" };
  }

  if (samePerformanceReservations >= 2) {
    return { allowed: false, reason: "MAX_PERFORMANCE_REACHED" };
  }

  return { allowed: true };
}

function createResponse(statusCode, body, origin) {
  return {
    statusCode,
    headers: {
      ...corsHeaders,
      "Access-Control-Allow-Origin": origin,
    },
    body: JSON.stringify(body),
  };
}

function createErrorResponse(statusCode, errorCode, errorMessage, origin) {
  return createResponse(statusCode, { errorCode, errorMessage }, origin);
}
