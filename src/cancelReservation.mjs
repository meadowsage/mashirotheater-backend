import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
  QueryCommand,
  BatchWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { createHash } from "crypto";
import { sendNotification } from "./utils/notification.js";

const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);
const ssmClient = new SSMClient({ region: process.env.AWS_REGION });

// 予約テーブル、ATTENDEES テーブルの名前を環境変数から取得
const RESERVATIONS_TABLE_NAME = process.env.RESERVATIONS_TABLE_NAME;
const ATTENDEES_TABLE_NAME = process.env.ATTENDEES_TABLE_NAME; // ← 追加
const STAGE = process.env.STAGE;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS.split(",");

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
  const origin = ALLOWED_ORIGINS.includes(event.headers.origin)
    ? event.headers.origin
    : ALLOWED_ORIGINS[0];

  if (event.httpMethod === "OPTIONS") {
    return createResponse(
      200,
      { message: "CORS preflight request successful" },
      origin
    );
  }

  try {
    const { id, token } = JSON.parse(event.body);
    if (!id || !token) {
      return createErrorResponse("E002", origin);
    }

    // 1. 予約レコードの取得
    const reservation = await getReservation(id);
    if (!reservation) {
      return createErrorResponse("E002", origin);
    }

    // 2. トークン検証
    const SECRET_KEY = await getSecretKey();
    const calculatedHash = createHash("sha256")
      .update(`${id}${SECRET_KEY}`)
      .digest("hex");

    if (token !== calculatedHash) {
      return createErrorResponse("E002", origin);
    }

    // 3. すでにキャンセルされていれば成功扱い
    if (reservation.status === "canceled") {
      return createResponse(200, { message: "SUCCESS" }, origin);
    }

    // 4. 予約ステータスを canceled に更新
    await updateReservationStatus(id, "canceled");

    // 5. Attendeesテーブルのレコードを削除
    //    reservationId で検索し、該当するすべてのAttendeeをDelete
    await deleteAttendeesForReservation(reservation.id);

    // 通知送信
    await sendNotification(
      `予約キャンセル: ID ${id}`,
      "INFO",
      "LOW",
      "cancelReservation"
    );

    return createResponse(200, { message: "SUCCESS" }, origin);
  } catch (error) {
    console.error("Error:", error);
    await sendNotification(
      `予約キャンセルエラー: ${error.message}`,
      "ERROR",
      "HIGH",
      "cancelReservation"
    );
    return createErrorResponse("E999", origin);
  }
};

function createResponse(statusCode, body, origin) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
    },
    body: JSON.stringify(body),
  };
}

function createErrorResponse(errorCode, origin) {
  return createResponse(400, { errorCode }, origin);
}

/** 予約レコードを取得 */
async function getReservation(reservationId) {
  const command = new GetCommand({
    TableName: RESERVATIONS_TABLE_NAME,
    Key: { id: reservationId },
  });
  const result = await dynamodb.send(command);
  return result.Item;
}

/** 予約のステータスを更新 */
async function updateReservationStatus(reservationId, status) {
  const command = new UpdateCommand({
    TableName: RESERVATIONS_TABLE_NAME,
    Key: { id: reservationId },
    UpdateExpression: "SET #status = :status, updatedAt = :updatedAt",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":status": status,
      ":updatedAt": new Date().toISOString(),
    },
  });
  await dynamodb.send(command);
}

/** 予約に紐づくAttendeesを削除 */
async function deleteAttendeesForReservation(reservationId) {
  // 1. Query Attendeesテーブル (Index: ReservationIdIndex) で該当レコードを取得
  let lastKey;
  do {
    const queryCmd = new QueryCommand({
      TableName: ATTENDEES_TABLE_NAME,
      IndexName: "ReservationIdIndex", // 事前に作成が必要
      KeyConditionExpression: "reservationId = :rid",
      ExpressionAttributeValues: {
        ":rid": reservationId,
      },
      ExclusiveStartKey: lastKey,
    });

    const res = await dynamodb.send(queryCmd);
    const items = res.Items || [];
    lastKey = res.LastEvaluatedKey;

    if (items.length > 0) {
      // 2. BatchWrite で削除
      await batchDeleteAttendees(items);
    }
  } while (lastKey);
}

/** BatchWriteCommandで Attendeesテーブルのアイテムを削除 */
async function batchDeleteAttendees(attendees) {
  // 1回の BatchWrite は最大25件
  const chunkSize = 25;
  for (let i = 0; i < attendees.length; i += chunkSize) {
    const slice = attendees.slice(i, i + chunkSize);

    const requestItems = slice.map((att) => ({
      DeleteRequest: {
        Key: { id: att.id }, // AttendeesテーブルのPK
      },
    }));

    const batchCommand = new BatchWriteCommand({
      RequestItems: {
        [ATTENDEES_TABLE_NAME]: requestItems,
      },
    });
    await dynamodb.send(batchCommand);
  }
}
