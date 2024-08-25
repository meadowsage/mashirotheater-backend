import https from "https";
import url from "url";

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const DISCORD_MENTION_ID = process.env.DISCORD_MENTION_ID;
const STAGE = process.env.STAGE || "dev"; // デフォルトをdevに設定

export const handler = async (event) => {
  console.log("Received event:", JSON.stringify(event, null, 2));

  for (const record of event.Records) {
    const snsMessage = JSON.parse(record.Sns.Message);

    let color = "";
    switch (snsMessage.type) {
      case "ERROR":
        color = 15158332; // Red
        break;
      case "WARNING":
        color = 16776960; // Yellow
        break;
      case "INFO":
      default:
        color = 3066993; // Green
        break;
    }

    let mentionString = "";
    if (snsMessage.type === "ERROR") {
      mentionString = process.env.DISCORD_MENTION_ID
        ? `<@&${process.env.DISCORD_MENTION_ID}> `
        : "";
    }

    const discordMessage = {
      content: mentionString, // メンションを content フィールドに設定
      embeds: [
        {
          title: `[${STAGE.toUpperCase()}] ${snsMessage.type}: ${
            snsMessage.service
          }`,
          description: snsMessage.message,
          color: color,
          timestamp: snsMessage.timestamp,
        },
      ],
    };
    await sendDiscordMessage(discordMessage);
  }

  return { statusCode: 200, body: "Notifications sent to Discord" };
};

function sendDiscordMessage(message) {
  return new Promise((resolve, reject) => {
    const webhookUrl = url.parse(DISCORD_WEBHOOK_URL);
    const requestOptions = {
      hostname: webhookUrl.host,
      path: webhookUrl.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
    };

    const req = https.request(requestOptions, (res) => {
      let response = "";
      res.on("data", (chunk) => {
        response += chunk;
      });
      res.on("end", () => {
        if (res.statusCode === 204) {
          resolve("Message sent successfully");
        } else {
          reject(`Failed to send message: ${res.statusCode} ${response}`);
        }
      });
    });

    req.on("error", (error) => {
      reject(`Error sending message: ${error}`);
    });

    req.write(JSON.stringify(message));
    req.end();
  });
}
