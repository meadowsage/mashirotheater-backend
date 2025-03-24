import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";

const dynamoClient = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);

const PERFORMANCES_TABLE_NAME = process.env.PERFORMANCES_TABLE_NAME;
const SCHEDULES_TABLE_NAME = process.env.SCHEDULES_TABLE_NAME;
const RESERVATIONS_TABLE_NAME = process.env.RESERVATIONS_TABLE_NAME;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS.split(",");
const THEATER_CAPACITY = 48; // 座席の上限(固定)

/** CORS用ヘッダ */
const corsHeaders = {
  "Access-Control-Allow-Methods": "PUT,OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
};

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

  const origin = ALLOWED_ORIGINS.includes(event.headers.origin)
    ? event.headers.origin
    : ALLOWED_ORIGINS[0];

  try {
    const performanceId = event.pathParameters?.performanceId;
    const queryParams = event.queryStringParameters || {};
    const adminUuid = queryParams.uuid;

    if (!performanceId || !adminUuid) {
      return createResponse(
        400,
        { errorCode: "E002", message: "Missing performanceId or uuid" },
        origin
      );
    }

    // リクエストボディをパース
    const body = JSON.parse(event.body || "{}");
    const { reservationStartTime, maxReservations, schedules } = body;

    // 1. Performances テーブルから公演情報を取得し、adminUuid をチェック
    const performanceItem = await getPerformance(performanceId);
    if (!performanceItem) {
      return createResponse(
        404,
        { errorCode: "E002", message: "Performance not found" },
        origin
      );
    }
    if (performanceItem.adminUuid !== adminUuid) {
      return createResponse(403, { message: "Forbidden" }, origin);
    }

    // 2. Schedules 一覧を取得し、後のバリデーションに使う
    const existingSchedules = await getSchedules(performanceId);
    const scheduleCount = existingSchedules.length;

    // 3. maxReservations バリデーション (0 <= maxReservations <= scheduleCount)
    if (maxReservations !== undefined) {
      if (
        typeof maxReservations !== "number" ||
        maxReservations < 0 ||
        maxReservations > scheduleCount
      ) {
        return createResponse(
          400,
          { errorCode: "E101", message: "maxReservations out of range" },
          origin
        );
      }
    }

    // 4. reservationStartTime のバリデーション (タイムゾーン込み)
    //    例: "2025-03-08T21:00:00+09:00"
    if (reservationStartTime !== undefined) {
      // 簡易的に Date(parseable) かどうかチェック
      const parsed = new Date(reservationStartTime);
      // isNaN(parsed.getTime()) → パース失敗
      if (isNaN(parsed.getTime())) {
        return createResponse(
          400,
          {
            errorCode: "E105",
            message:
              "Invalid date/time format (must be valid ISO8601, e.g. 2025-03-08T21:00:00+09:00)",
          },
          origin
        );
      }
      // パース可能ならOK → 実際には文字列を変換せず、そのまま保存
    }

    // 5. schedules の更新差分をチェック
    if (Array.isArray(schedules)) {
      for (const schUpdate of schedules) {
        const { id, totalSeats, entryUrl } = schUpdate;

        // スケジュールが存在するか
        const existing = existingSchedules.find((s) => s.id === id);
        if (!existing) {
          return createResponse(
            400,
            {
              errorCode: "E002",
              message: `Schedule ${id} not found in performance ${performanceId}`,
            },
            origin
          );
        }

        // (A) totalSeats バリデーション
        if (totalSeats !== undefined) {
          if (typeof totalSeats !== "number") {
            return createResponse(
              400,
              { errorCode: "E102", message: "Invalid totalSeats type" },
              origin
            );
          }
          if (totalSeats > THEATER_CAPACITY) {
            return createResponse(
              400,
              {
                errorCode: "E102",
                message: `totalSeats exceeds ${THEATER_CAPACITY}`,
              },
              origin
            );
          }
          const reserved = await getReservedSeats(performanceId, id, [
            "pending",
            "confirmed",
          ]);
          if (totalSeats < reserved) {
            return createResponse(
              400,
              {
                errorCode: "E103",
                message: `totalSeats(${totalSeats}) is less than reserved(${reserved})`,
              },
              origin
            );
          }
        }

        // (B) entryUrl バリデーション
        if (entryUrl !== undefined) {
          const hasReminderSent = await hasReminderEmailSent(performanceId, id);
          if (hasReminderSent) {
            return createResponse(
              400,
              {
                errorCode: "E104",
                message: `Cannot change entryUrl because reminder emails have been sent for schedule ${id}`,
              },
              origin
            );
          }
        }
      }
    }

    // 6. 更新ロジック
    // 6-1. Performances テーブル (reservationStartTime, maxReservations)
    if (reservationStartTime !== undefined || maxReservations !== undefined) {
      const updateExpressions = [];
      const attrNames = {};
      const attrValues = {};

      if (reservationStartTime !== undefined) {
        updateExpressions.push("#rst = :rst");
        attrNames["#rst"] = "reservationStartTime";
        // 文字列をそのまま保存
        attrValues[":rst"] = reservationStartTime;
      }
      if (maxReservations !== undefined) {
        updateExpressions.push("#mr = :mr");
        attrNames["#mr"] = "maxReservations";
        attrValues[":mr"] = maxReservations;
      }

      if (updateExpressions.length > 0) {
        const updateExpression = "SET " + updateExpressions.join(", ");
        const command = new UpdateCommand({
          TableName: PERFORMANCES_TABLE_NAME,
          Key: { id: performanceId },
          UpdateExpression: updateExpression,
          ExpressionAttributeNames: attrNames,
          ExpressionAttributeValues: attrValues,
        });
        await dynamodb.send(command);
      }
    }

    // 6-2. Schedules テーブル (totalSeats, entryUrl)
    if (Array.isArray(schedules)) {
      for (const schUpdate of schedules) {
        const { id, totalSeats, entryUrl } = schUpdate;
        const updateSet = [];
        const attrNames = {};
        const attrValues = {};

        if (totalSeats !== undefined) {
          updateSet.push("#ts = :ts");
          attrNames["#ts"] = "totalSeats";
          attrValues[":ts"] = totalSeats;
        }
        if (entryUrl !== undefined) {
          updateSet.push("#eu = :eu");
          attrNames["#eu"] = "entryUrl";
          attrValues[":eu"] = entryUrl;
        }

        if (updateSet.length > 0) {
          const updExpr = "SET " + updateSet.join(", ");
          const command = new UpdateCommand({
            TableName: SCHEDULES_TABLE_NAME,
            Key: { performanceId, id },
            UpdateExpression: updExpr,
            ExpressionAttributeNames: attrNames,
            ExpressionAttributeValues: attrValues,
          });
          await dynamodb.send(command);
        }
      }
    }

    // 成功レスポンス
    return createResponse(
      200,
      { message: "Performance updated successfully" },
      origin
    );
  } catch (error) {
    console.error("Error updating performance:", error);
    return createResponse(
      500,
      { errorCode: "E999", message: "Internal server error" },
      origin
    );
  }
};

/** Performance取得 */
async function getPerformance(performanceId) {
  const cmd = new GetCommand({
    TableName: PERFORMANCES_TABLE_NAME,
    Key: { id: performanceId },
  });
  const res = await dynamodb.send(cmd);
  return res.Item;
}

/** スケジュール一覧取得 */
async function getSchedules(performanceId) {
  const cmd = new QueryCommand({
    TableName: SCHEDULES_TABLE_NAME,
    KeyConditionExpression: "performanceId = :pid",
    ExpressionAttributeValues: {
      ":pid": performanceId,
    },
  });
  const res = await dynamodb.send(cmd);
  return res.Items || [];
}

/** 指定ステータスの予約合計人数を取得 */
async function getReservedSeats(performanceId, scheduleId, statuses) {
  const cmd = new QueryCommand({
    TableName: RESERVATIONS_TABLE_NAME,
    IndexName: "GSI1",
    KeyConditionExpression: "performanceId = :pid AND scheduleId = :sid",
    FilterExpression:
      "#st IN (" + statuses.map((_, i) => `:s${i}`).join(", ") + ")",
    ExpressionAttributeNames: {
      "#st": "status",
    },
    ExpressionAttributeValues: {
      ":pid": performanceId,
      ":sid": scheduleId,
      ...statuses.reduce((acc, s, i) => {
        acc[`:s${i}`] = s;
        return acc;
      }, {}),
    },
    ProjectionExpression: "reservedSeats",
  });
  const res = await dynamodb.send(cmd);
  const items = res.Items || [];
  return items.reduce((sum, r) => sum + r.reservedSeats, 0);
}

/** リマインドメール送信済み予約があるか判定 */
async function hasReminderEmailSent(performanceId, scheduleId) {
  const cmd = new QueryCommand({
    TableName: RESERVATIONS_TABLE_NAME,
    IndexName: "GSI1",
    KeyConditionExpression: "performanceId = :pid AND scheduleId = :sid",
    FilterExpression: "reminderEmailSent = :trueVal",
    ExpressionAttributeValues: {
      ":pid": performanceId,
      ":sid": scheduleId,
      ":trueVal": true,
    },
    ProjectionExpression: "id",
  });
  const res = await dynamodb.send(cmd);
  return (res.Items || []).length > 0;
}
