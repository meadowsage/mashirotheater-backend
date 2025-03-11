import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);

const performancesTableName = process.env.PERFORMANCES_TABLE_NAME;
const schedulesTableName = process.env.SCHEDULES_TABLE_NAME;
const reservationsTableName = process.env.RESERVATIONS_TABLE_NAME;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS.split(",");

const corsHeaders = {
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
};

const TIME_ZONE = "Asia/Tokyo";

function getJSTDate(date = new Date()) {
  return new Date(date.toLocaleString("en-US", { timeZone: TIME_ZONE }));
}

function isWithinOneHourBeforeStart(schedule) {
  const now = getJSTDate();
  const performanceTime = new Date(`${schedule.date}T${schedule.time}`);
  const oneHourBefore = new Date(performanceTime.getTime() - 60 * 60 * 1000);
  return now < oneHourBefore;
}

const createResponse = (statusCode, body, origin) => {
  return {
    statusCode,
    headers: {
      ...corsHeaders,
      "Access-Control-Allow-Origin": origin,
    },
    body: JSON.stringify(body),
  };
};

export const handler = async (event) => {
  console.log("Received event:", JSON.stringify(event, null, 2));

  const origin = ALLOWED_ORIGINS.includes(event.headers.origin)
    ? event.headers.origin
    : ALLOWED_ORIGINS[0];

  try {
    const performanceId = event.pathParameters?.performanceId;
    if (!performanceId) {
      return createResponse(
        400,
        { message: "Missing or invalid performanceId" },
        origin
      );
    }

    const performance = await getPerformance(performanceId);
    if (!performance) {
      return createResponse(
        404,
        { errorCode: "E002", message: "Performance not found" },
        origin
      );
    }

    // 予約開始時間のチェック
    const now = getJSTDate();
    const reservationStartTime = getJSTDate(
      new Date(performance.reservationStartTime)
    );
    if (now < reservationStartTime) {
      return createResponse(
        200,
        {
          id: performance.id,
          title: performance.title,
          reservationStatus: "not_started",
          reservationStartTime: performance.reservationStartTime,
        },
        origin
      );
    }
    const schedules = await getSchedules(performanceId);
    const schedulesWithAvailableSeats = await Promise.all(
      schedules.map(getAvailableSeats)
    );
    const formattedSchedules = schedulesWithAvailableSeats
      .filter(isWithinOneHourBeforeStart)
      .map(formatSchedule);

    if (formattedSchedules.length === 0) {
      return createResponse(
        200,
        {
          id: performance.id,
          title: performance.title,
          reservationStatus: "closed",
          message:
            "All performances are within one hour of start time or have already begun.",
        },
        origin
      );
    }

    if (!performance.maxReservations) {
      performance.maxReservations = 0;
    }

    return createResponse(
      200,
      {
        id: performance.id,
        title: performance.title,
        reservationStatus: "open",
        schedules: formattedSchedules,
        maxReservations: performance.maxReservations,
      },
      origin
    );
  } catch (error) {
    console.error("Error:", error);
    return createResponse(500, { message: "Internal server error" }, origin);
  }
};

async function getPerformance(performanceId) {
  const command = new GetCommand({
    TableName: performancesTableName,
    Key: { id: performanceId },
  });
  const result = await dynamodb.send(command);
  return result.Item;
}

async function getSchedules(performanceId) {
  const command = new QueryCommand({
    TableName: schedulesTableName,
    KeyConditionExpression: "performanceId = :pid",
    ExpressionAttributeValues: {
      ":pid": performanceId,
    },
  });
  const result = await dynamodb.send(command);
  return result.Items;
}

async function getAvailableSeats(schedule) {
  const reservationsCommand = new QueryCommand({
    TableName: reservationsTableName,
    IndexName: "GSI1",
    KeyConditionExpression: "performanceId = :pid AND scheduleId = :sid",
    FilterExpression: "#status IN (:pending, :confirmed)",
    ExpressionAttributeNames: {
      "#status": "status",
    },
    ExpressionAttributeValues: {
      ":pid": schedule.performanceId,
      ":sid": schedule.id,
      ":pending": "pending",
      ":confirmed": "confirmed",
    },
    ProjectionExpression: "reservedSeats",
  });

  const reservationsResult = await dynamodb.send(reservationsCommand);
  const reservedSeats = reservationsResult.Items.reduce(
    (total, item) => total + item.reservedSeats,
    0
  );
  const availableSeats = schedule.totalSeats - reservedSeats;

  return { ...schedule, availableSeats };
}

function formatSchedule(schedule) {
  // DBに格納されている日時はすでに日本時間なので、getJSTDate()は使用しない
  const date = new Date(`${schedule.date}T${schedule.time}`);
  return {
    id: schedule.id,
    date: formatDate(date),
    time: formatTime(date),
    remainingSeats: Math.max(0, schedule.availableSeats),
  };
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatTime(date) {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}
