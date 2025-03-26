import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);

const PERFORMANCES_TABLE_NAME = process.env.PERFORMANCES_TABLE_NAME;
const SCHEDULES_TABLE_NAME = process.env.SCHEDULES_TABLE_NAME;
const RESERVATIONS_TABLE_NAME = process.env.RESERVATIONS_TABLE_NAME;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS.split(",");

// CORS用のヘッダー
const corsHeaders = {
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
};

// レスポンス生成
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

export const handler = async (event) => {
  console.log("Received event:", JSON.stringify(event, null, 2));

  // 呼び出し元の Origin をチェック
  const origin = ALLOWED_ORIGINS.includes(event.headers.origin)
    ? event.headers.origin
    : ALLOWED_ORIGINS[0];

  try {
    const performanceId = event.pathParameters?.performanceId;
    const queryParams = event.queryStringParameters || {};
    const adminUuid = queryParams.uuid;

    // パラメータ検証
    if (!performanceId || !adminUuid) {
      return createResponse(
        400,
        { message: "Missing performanceId or uuid" },
        origin
      );
    }

    // Performances テーブルから公演情報を取得
    const performance = await getPerformance(performanceId);
    if (!performance) {
      return createResponse(404, { message: "Performance not found" }, origin);
    }

    // 管理用 UUID の照合
    if (performance.adminUuid !== adminUuid) {
      return createResponse(403, { message: "Forbidden" }, origin);
    }

    // Schedules テーブルから全スケジュールを取得
    const schedules = await getSchedules(performanceId);

    // 各スケジュールについて、有効な予約数を取得しフィールドに追加
    const schedulesWithActiveReservations = [];
    for (const schedule of schedules) {
      const activeCount = await getActiveReservationCount(
        performanceId,
        schedule.id
      );
      const formatted = formatSchedule(schedule);
      schedulesWithActiveReservations.push({
        ...formatted,
        reservedSeats: activeCount,
      });
    }

    // null の項目があれば空文字 / 0 に置き換え
    const safeReservationStartTime = performance.reservationStartTime || "";
    const safeMaxReservations =
      typeof performance.maxReservations === "number"
        ? performance.maxReservations
        : 0;
    const safeTitle = performance.title || "";

    // レスポンスデータ
    const responseBody = {
      id: performance.id,
      title: safeTitle,
      reservationStartTime: safeReservationStartTime,
      maxReservations: safeMaxReservations,
      schedules: schedulesWithActiveReservations,
    };

    return createResponse(200, responseBody, origin);
  } catch (error) {
    console.error("Error in getPerformanceDetailsAdmin:", error);
    return createResponse(500, { message: "Internal server error" }, origin);
  }
};

/** 公演 (Performances テーブル) から1件取得 */
async function getPerformance(performanceId) {
  const command = new GetCommand({
    TableName: PERFORMANCES_TABLE_NAME,
    Key: { id: performanceId },
  });
  const result = await dynamodb.send(command);
  return result.Item;
}

/** スケジュール一覧取得 (全件) */
async function getSchedules(performanceId) {
  const command = new QueryCommand({
    TableName: SCHEDULES_TABLE_NAME,
    KeyConditionExpression: "performanceId = :pid",
    ExpressionAttributeValues: {
      ":pid": performanceId,
    },
  });
  const result = await dynamodb.send(command);
  return result.Items || [];
}

/** 有効な予約数（仮予約含む）を取得 */
async function getActiveReservationCount(performanceId, scheduleId) {
  // Reservationsテーブルを Query し、status IN ('pending','confirmed') の reservedSeats を合計
  // GSI1: partitionKey=performanceId, sortKey=scheduleId
  const command = new QueryCommand({
    TableName: RESERVATIONS_TABLE_NAME,
    IndexName: "GSI1",
    KeyConditionExpression: "performanceId = :pid AND scheduleId = :sid",
    FilterExpression: "#st IN (:pending, :confirmed)",
    ExpressionAttributeNames: {
      "#st": "status",
    },
    ExpressionAttributeValues: {
      ":pid": performanceId,
      ":sid": scheduleId,
      ":pending": "pending",
      ":confirmed": "confirmed",
    },
    ProjectionExpression: "reservedSeats",
  });

  const result = await dynamodb.send(command);
  const items = result.Items || [];
  let total = 0;
  for (const r of items) {
    total += r.reservedSeats;
  }
  return total;
}

/** スケジュールをフォーマット */
function formatSchedule(schedule) {
  // 好みに応じて日付フォーマット
  const dateObj = new Date(`${schedule.date}T${schedule.time}`);
  return {
    id: schedule.id,
    date: formatDate(dateObj),
    time: formatTime(dateObj),
    totalSeats: schedule.totalSeats || 0,
    entryUrl: schedule.entryUrl || "",
  };
}

/** YYYY-MM-DD */
function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** HH:mm */
function formatTime(date) {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
