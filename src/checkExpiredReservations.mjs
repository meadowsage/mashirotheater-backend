import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { sendNotification } from "./utils/notification.js";

const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);

const RESERVATIONS_TABLE_NAME = process.env.RESERVATIONS_TABLE_NAME;
const RESERVATION_EXPIRATION_HOURS = 1; // 予約の有効期限（時間）

export const handler = async (event) => {
  console.log("Received event:", JSON.stringify(event, null, 2));

  try {
    const expiredReservations = await getExpiredReservations();
    await Promise.all(expiredReservations.map(updateReservationToExpired));

    if (expiredReservations.length > 0) {
      await sendNotification(
        `失効チェック: ${expiredReservations.length}件の予約が失効しました`,
        "INFO",
        "LOW",
        "checkExpiredReservations"
      );
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: `${expiredReservations.length} reservations marked as expired`,
      }),
    };
  } catch (error) {
    console.error("Error:", error);
    await sendNotification(
      `失効チェックエラー: ${error.message}`,
      "ERROR",
      "HIGH",
      "checkExpiredReservations"
    );
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "Internal server error" }),
    };
  }
};

async function getExpiredReservations() {
  // 期限切れ基準時刻 (now - 1時間)
  const expirationTime = new Date(
    Date.now() - RESERVATION_EXPIRATION_HOURS * 60 * 60 * 1000
  ).toISOString();

  const command = new ScanCommand({
    TableName: RESERVATIONS_TABLE_NAME,
    FilterExpression: "#status = :status AND createdAt < :expirationTime",
    ExpressionAttributeNames: {
      "#status": "status",
    },
    ExpressionAttributeValues: {
      ":status": "pending",
      ":expirationTime": expirationTime,
    },
  });

  const result = await dynamodb.send(command);
  return result.Items || [];
}

async function updateReservationToExpired(reservation) {
  const command = new UpdateCommand({
    TableName: RESERVATIONS_TABLE_NAME,
    Key: { id: reservation.id },
    UpdateExpression: "SET #status = :expired, updatedAt = :updatedAt",
    ConditionExpression: "#status = :pending", // すでに変更されていたら上書きしない
    ExpressionAttributeNames: {
      "#status": "status",
    },
    ExpressionAttributeValues: {
      ":pending": "pending",
      ":expired": "expired",
      ":updatedAt": new Date().toISOString(),
    },
  });

  try {
    await dynamodb.send(command);
    console.log("expired: " + reservation.id);
  } catch (error) {
    // もし #status != pending（たとえば confirmed になった）なら ConditionalCheckFailedException が投げられる
    if (error.name === "ConditionalCheckFailedException") {
      console.log(`skip expiring: ${reservation.id} (already changed)`);
      // ここでは特に再スローせず、単にスキップ扱いにする
    } else {
      throw error;
    }
  }
}
