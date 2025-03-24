import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { v4 as uuidv4 } from "uuid";

const ddbClient = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(ddbClient);

const RESERVATIONS_TABLE_NAME = process.env.RESERVATIONS_TABLE_NAME;
const ATTENDEES_TABLE_NAME = process.env.ATTENDEES_TABLE_NAME;

export const handler = async (event) => {
  console.log("Starting createAttendeesBatch job...");

  try {
    // 1. 全Reservationをスキャン (status=confirmed)
    const confirmedReservations = await getAllConfirmedReservations();

    let createdCount = 0;
    for (const reservation of confirmedReservations) {
      const { id } = reservation;

      // Attendeesが既に存在すればスキップ
      const alreadyExists = await hasAnyAttendees(id);
      if (alreadyExists) {
        console.log(`Reservation ${id} already has attendees. Skipping.`);
        continue;
      }

      // メイン予約者だけ reservations.notes をコピー
      const attendeeItems = buildAttendeeRecords(reservation);

      // トランザクション or batchWrite で書き込み
      await createAttendeesTransact(attendeeItems);

      console.log(`Attendees created for reservation ${id}`);
      createdCount++;
    }

    console.log(
      `Batch completed. Created Attendees for ${createdCount} reservations.`
    );
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Attendees batch creation completed",
        createdCount,
      }),
    };
  } catch (err) {
    console.error("Error in createAttendeesBatch:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Internal server error",
        error: err.message,
      }),
    };
  }
};

async function getAllConfirmedReservations() {
  let confirmedList = [];
  let lastKey;

  do {
    const scanCommand = new ScanCommand({
      TableName: RESERVATIONS_TABLE_NAME,
      FilterExpression: "#st = :confirmed",
      ExpressionAttributeNames: { "#st": "status" },
      ExpressionAttributeValues: { ":confirmed": "confirmed" },
      ExclusiveStartKey: lastKey,
    });

    const result = await dynamodb.send(scanCommand);
    const items = result.Items || [];

    confirmedList.push(...items);
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return confirmedList;
}

async function hasAnyAttendees(reservationId) {
  // 予約IDでAttendeesをGSI検索する想定
  const queryCmd = new QueryCommand({
    TableName: ATTENDEES_TABLE_NAME,
    IndexName: "ReservationIdIndex",
    KeyConditionExpression: "reservationId = :rid",
    ExpressionAttributeValues: {
      ":rid": reservationId,
    },
    Limit: 1,
  });
  const res = await dynamodb.send(queryCmd);
  return (res.Items || []).length > 0;
}

/** メイン予約者だけ reservations.notes をコピー、 お連れ様は空文字 */
function buildAttendeeRecords(reservation) {
  const {
    id: reservationId,
    performanceId,
    scheduleId,
    name,
    reservedSeats,
    createdAt,
    notes, // Reservationテーブルのnotes
  } = reservation;
  const now = new Date().toISOString();

  const attendeeItems = [];
  for (let i = 0; i < reservedSeats; i++) {
    // occupantName: 1人目は name, 2人目以降は " お連れ様" 付き
    const occupantName = i === 0 ? name : `${name} お連れ様`;
    // notes は 1人目(i=0) だけコピー、 2人目以降は空文字
    const occupantNotes = i === 0 ? notes || "" : "";

    attendeeItems.push({
      id: `ATT-${uuidv4()}`,
      reservationId,
      performanceId,
      scheduleId,
      name: occupantName,
      checkedIn: false,
      createdAt: now,
      notes: occupantNotes,
    });
  }
  return attendeeItems;
}

async function createAttendeesTransact(attendeeItems) {
  if (attendeeItems.length === 0) return;

  const transactItems = attendeeItems.map((item) => ({
    Put: {
      TableName: ATTENDEES_TABLE_NAME,
      Item: item,
    },
  }));

  const chunkSize = 25;
  for (let i = 0; i < transactItems.length; i += chunkSize) {
    const slice = transactItems.slice(i, i + chunkSize);
    const cmd = new TransactWriteCommand({ TransactItems: slice });
    await dynamodb.send(cmd);
  }
}
