import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

// 環境変数等
const dynamoClient = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);

const ATTENDEES_TABLE_NAME = process.env.ATTENDEES_TABLE_NAME;
const PERFORMANCES_TABLE_NAME = process.env.PERFORMANCES_TABLE_NAME;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS.split(",");

/** CORS用ヘッダ */
const corsHeaders = {
  "Access-Control-Allow-Methods": "PATCH,OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
};

/** レスポンス返却ユーティリティ */
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

  // CORS origin
  const origin = ALLOWED_ORIGINS.includes(event.headers.origin)
    ? event.headers.origin
    : ALLOWED_ORIGINS[0];

  // OPTIONSリクエストならCORSプリフライト
  if (event.httpMethod === "OPTIONS") {
    return createResponse(200, { message: "CORS preflight request" }, origin);
  }

  try {
    const attendeeId = event.pathParameters?.attendeeId;
    const queryParams = event.queryStringParameters || {};
    const adminUuid = queryParams.uuid;

    if (!attendeeId || !adminUuid) {
      return createResponse(
        400,
        {
          message: "Missing attendeeId or uuid",
        },
        origin
      );
    }

    // リクエストボディをパース
    const body = JSON.parse(event.body || "{}");
    const { checkedIn } = body;

    // checkedInがbooleanであることを簡単にチェック
    if (typeof checkedIn !== "boolean") {
      return createResponse(
        400,
        {
          message: "checkedIn must be boolean",
        },
        origin
      );
    }

    // 1. attendee取得
    const attendee = await getAttendee(attendeeId);
    if (!attendee) {
      return createResponse(
        404,
        {
          message: "Attendee not found",
        },
        origin
      );
    }

    // 2. performance取得 & adminUuid照合
    //    attendee には { performanceId, scheduleId, ... } が含まれる想定
    const performance = await getPerformance(attendee.performanceId);
    if (!performance) {
      return createResponse(
        404,
        {
          message: "Performance not found",
        },
        origin
      );
    }
    if (performance.adminUuid !== adminUuid) {
      return createResponse(
        403,
        {
          message: "Forbidden",
        },
        origin
      );
    }

    // 3. AttendeesテーブルをUpdate
    await updateAttendeeCheckin(attendeeId, checkedIn);

    return createResponse(
      200,
      {
        message: "Checkin status updated",
        attendeeId,
        checkedIn,
      },
      origin
    );
  } catch (error) {
    console.error("Error in updateCheckinAdmin:", error);
    return createResponse(
      500,
      {
        message: "Internal server error",
      },
      origin
    );
  }
};

/** Attendeesテーブルから1件をGet */
async function getAttendee(attendeeId) {
  const cmd = new GetCommand({
    TableName: ATTENDEES_TABLE_NAME,
    Key: { id: attendeeId },
  });
  const res = await dynamodb.send(cmd);
  return res.Item;
}

/** Performancesテーブルから1件をGet */
async function getPerformance(performanceId) {
  const cmd = new GetCommand({
    TableName: PERFORMANCES_TABLE_NAME,
    Key: { id: performanceId },
  });
  const res = await dynamodb.send(cmd);
  return res.Item;
}

/** Attendeesテーブルで checkedIn を更新 */
async function updateAttendeeCheckin(attendeeId, checkedIn) {
  const cmd = new UpdateCommand({
    TableName: ATTENDEES_TABLE_NAME,
    Key: { id: attendeeId },
    UpdateExpression: "SET checkedIn = :val",
    ExpressionAttributeValues: {
      ":val": checkedIn,
    },
  });
  await dynamodb.send(cmd);
}
