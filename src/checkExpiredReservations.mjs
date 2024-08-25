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

    // await sendNotification(
    //   `失効チェック完了`,
    //   "INFO",
    //   "LOW",
    //   "checkExpiredReservations"
    // );
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
    UpdateExpression: "SET #status = :status, updatedAt = :updatedAt",
    ExpressionAttributeNames: {
      "#status": "status",
    },
    ExpressionAttributeValues: {
      ":status": "expired",
      ":updatedAt": new Date().toISOString(),
    },
  });

  await dynamodb.send(command);
  console.log("expired: " + reservation.id);
}
