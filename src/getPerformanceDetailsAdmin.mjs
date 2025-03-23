import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";

// 環境変数でテーブル名を取得
const PERFORMANCES_TABLE_NAME = process.env.PERFORMANCES_TABLE_NAME;
const SCHEDULES_TABLE_NAME = process.env.SCHEDULES_TABLE_NAME;

// DynamoDB Client 初期化
const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);

export const handler = async (event) => {
  console.log("Received event:", JSON.stringify(event, null, 2));

  try {
    // 1) パス & クエリパラメータの取得
    //    例: /admin/performances/{performanceId}?uuid=xxxxx
    //    serverless.yml 側のpaths指定で pathParameters.performanceId が入る想定
    const performanceId = event.pathParameters?.performanceId;
    const queryParams = event.queryStringParameters || {};
    const adminUuid = queryParams.uuid;

    if (!performanceId || !adminUuid) {
      return createResponse(400, {
        message: "Missing performanceId or uuid",
      });
    }

    // 2) Performancesテーブルから公演情報を取得
    const performance = await getPerformance(performanceId);
    if (!performance) {
      // 存在しなければ 404
      return createResponse(404, { message: "Performance not found" });
    }

    // 3) adminUuid のチェック
    if (performance.adminUuid !== adminUuid) {
      // 管理用UUIDが一致しない => 403
      return createResponse(403, { message: "Forbidden" });
    }

    // 4) Schedulesテーブルから該当公演のスケジュール一覧を取得
    const schedules = await getSchedules(performanceId);

    // 5) null項目をデフォルト値に置き換える
    //   reservationStartTime が null/undefined なら空文字
    //   maxReservations が null/undefined なら 0
    const safeReservationStartTime = performance.reservationStartTime || "";
    const safeMaxReservations =
      typeof performance.maxReservations === "number"
        ? performance.maxReservations
        : 0;

    // 6) スケジュールの null を空文字等に置換 (entryUrl, date, timeなど)
    const formattedSchedules = schedules.map((sch) => ({
      id: sch.id,
      date: sch.date || "",
      time: sch.time || "",
      totalSeats: sch.totalSeats ?? 0, // null/undefinedなら0
      entryUrl: sch.entryUrl || "",
    }));

    // 7) 必要な情報をまとめて返す
    //    ここでtitleもnullなら空文字にしておく例
    const responseBody = {
      id: performance.id,
      title: performance.title || "",
      reservationStartTime: safeReservationStartTime,
      maxReservations: safeMaxReservations,
      schedules: formattedSchedules,
    };

    return createResponse(200, responseBody);
  } catch (error) {
    console.error("Error in getPerformanceDetailsAdmin:", error);
    return createResponse(500, {
      message: "Internal Server Error",
      error: error.message,
    });
  }
};

/** DynamoDBから Performance を Get */
async function getPerformance(performanceId) {
  const command = new GetCommand({
    TableName: PERFORMANCES_TABLE_NAME,
    Key: { id: performanceId },
  });
  const result = await dynamodb.send(command);
  return result.Item; // null if not found
}

/** DynamoDBから該当公演のスケジュール一覧を取得 */
async function getSchedules(performanceId) {
  // パーティションキー = performanceId, ソートキー = id
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

/** 便利関数: レスポンスを整形 */
function createResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  };
}
