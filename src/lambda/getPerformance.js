const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');

const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);

const performancesTableName = process.env.PERFORMANCES_TABLE_NAME;
const schedulesTableName = process.env.SCHEDULES_TABLE_NAME;
const reservationsTableName = process.env.RESERVATIONS_TABLE_NAME;

exports.handler = async (event) => {
    console.log("Event:", JSON.stringify(event));

    const performanceId = event.pathParameters.performanceId;

    if (!performanceId || typeof performanceId !== 'string') {
        return {
            statusCode: 400,
            body: JSON.stringify({ message: "Invalid performanceId" })
        };
    }

    try {
        const performance = await getPerformance(performanceId);
        if (!performance) {
            return {
                statusCode: 404,
                body: JSON.stringify({ message: "Performance not found" })
            };
        }

        const schedules = await getSchedules(performanceId);
        const schedulesWithRemainingSeats = await Promise.all(
            schedules.map(schedule => addRemainingSeats(schedule))
        );

        return {
            statusCode: 200,
            body: JSON.stringify({
                id: performance.id,
                title: performance.title,
                schedules: schedulesWithRemainingSeats
            })
        };
    } catch (error) {
        console.error("Error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ message: "Internal server error" })
        };
    }
};

async function getPerformance(performanceId) {
    const command = new GetCommand({
        TableName: performancesTableName,
        Key: { id: performanceId }
    });
    const result = await dynamodb.send(command);
    return result.Item;
}

async function getSchedules(performanceId) {
    const command = new QueryCommand({
        TableName: schedulesTableName,
        KeyConditionExpression: "performanceId = :pid",
        ExpressionAttributeValues: {
            ":pid": performanceId
        }
    });
    const result = await dynamodb.send(command);
    return result.Items;
}

async function addRemainingSeats(schedule) {
    const reservedSeats = await getReservedSeats(schedule.performanceId, schedule.id);
    const remainingSeats = Math.max(0, schedule.totalSeats - reservedSeats);

    // JSTに変換（9時間追加）
    const date = new Date(`${schedule.date}T${schedule.time}Z`);
    date.setHours(date.getHours() + 9);

    return {
        id: schedule.id,
        date: formatDate(date),
        time: formatTime(date),
        remainingSeats
    };
}

function formatDate(date) {
    return date.toISOString().split('T')[0];
}

function formatTime(date) {
    return date.toTimeString().split(' ')[0].substr(0, 5);
}

async function getReservedSeats(performanceId, scheduleId) {
    const command = new QueryCommand({
        TableName: reservationsTableName,
        KeyConditionExpression: "performanceId = :pid AND scheduleId = :sid",
        ExpressionAttributeValues: {
            ":pid": performanceId,
            ":sid": scheduleId
        }
    });
    const result = await dynamodb.send(command);
    return result.Items.length;
}