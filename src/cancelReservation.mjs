import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { createHash } from "crypto";

const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);
const ssmClient = new SSMClient({ region: process.env.AWS_REGION });

const RESERVATIONS_TABLE_NAME = process.env.RESERVATIONS_TABLE_NAME;
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

    const reservation = await getReservation(id);
    if (!reservation) {
      return createErrorResponse("E002", origin);
    }

    const SECRET_KEY = await getSecretKey();
    const calculatedHash = createHash("sha256")
      .update(`${id}${SECRET_KEY}`)
      .digest("hex");

    if (token !== calculatedHash) {
      return createErrorResponse("E002", origin);
    }

    if (reservation.status === "canceled") {
      // キャンセル済の場合も成功扱いにする
      return createResponse(200, { message: "SUCCESS" }, origin);
    }

    await updateReservationStatus(id, "canceled");
    return createResponse(200, { message: "SUCCESS" }, origin);
  } catch (error) {
    console.error("Error:", error);
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

async function getReservation(reservationId) {
  const command = new GetCommand({
    TableName: RESERVATIONS_TABLE_NAME,
    Key: { id: reservationId },
  });
  const result = await dynamodb.send(command);
  return result.Item;
}

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
