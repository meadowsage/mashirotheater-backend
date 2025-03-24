import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";

// 環境変数
const ddbClient = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(ddbClient);

const PERFORMANCES_TABLE_NAME = process.env.PERFORMANCES_TABLE_NAME;
const ATTENDEES_TABLE_NAME = process.env.ATTENDEES_TABLE_NAME;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS.split(",");

// CORS用ヘッダー
const corsHeaders = {
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
};

// 共通のレスポンス生成関数
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
    const scheduleId = event.pathParameters?.scheduleId;
    const queryParams = event.queryStringParameters || {};
    const adminUuid = queryParams.uuid;

    // 入力チェック
    if (!performanceId || !scheduleId || !adminUuid) {
      return createResponse(
        400,
        { message: "Missing required parameters" },
        origin
      );
    }

    // 1. Performancesテーブルから公演情報を取得し、adminUuidを照合
    const performance = await getPerformance(performanceId);
    if (!performance) {
      return createResponse(404, { message: "Performance not found" }, origin);
    }
    if (performance.adminUuid !== adminUuid) {
      return createResponse(403, { message: "Forbidden" }, origin);
    }

    // 2. Attendeesテーブルから該当の performanceId + scheduleId で検索
    const attendees = await getAttendees(performanceId, scheduleId);

    // 3. JSON整形。フロントで使いやすい形式にする。
    const formatted = attendees.map((att) => ({
      attendeeId: att.id,
      reservationId: att.reservationId,
      name: att.name,
      checkedIn: att.checkedIn,
      createdAt: att.createdAt,
      notes: att.notes || "",
    }));

    return createResponse(200, formatted, origin);
  } catch (error) {
    console.error("Error in getAttendeesAdmin:", error);
    return createResponse(500, { message: "Internal server error" }, origin);
  }
};

// Performancesテーブルから公演1件を取得
async function getPerformance(performanceId) {
  const cmd = new GetCommand({
    TableName: PERFORMANCES_TABLE_NAME,
    Key: { id: performanceId },
  });
  const res = await dynamodb.send(cmd);
  return res.Item;
}

// AttendeesテーブルのGSIで、performanceId + scheduleIdに一致するレコードを検索
async function getAttendees(performanceId, scheduleId) {
  const cmd = new QueryCommand({
    TableName: ATTENDEES_TABLE_NAME,
    IndexName: "PerformanceIdScheduleIdIndex",
    KeyConditionExpression: "performanceId = :pid AND scheduleId = :sid",
    ExpressionAttributeValues: {
      ":pid": performanceId,
      ":sid": scheduleId,
    },
  });
  const res = await dynamodb.send(cmd);
  return res.Items || [];
}
