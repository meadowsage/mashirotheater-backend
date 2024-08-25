import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

const snsClient = new SNSClient({ region: process.env.AWS_REGION });

export async function sendNotification(
  message,
  type = "INFO",
  severity = "LOW",
  service
) {
  const notificationMessage = {
    type,
    service,
    message,
    timestamp: new Date().toISOString(),
    severity,
  };

  const params = {
    Message: JSON.stringify(notificationMessage),
    TopicArn: process.env.SYSTEM_NOTIFICATIONS_TOPIC_ARN,
  };

  try {
    await snsClient.send(new PublishCommand(params));
  } catch (error) {
    console.error("Error sending notification:", error);
  }
}
