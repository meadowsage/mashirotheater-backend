import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const s3Client = new S3Client({ region: process.env.AWS_REGION });
const BUCKET_NAME = `${process.env.ENV}-mashirotheater-templates`;

// __dirname の代替
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function uploadTemplate(fileName) {
  const filePath = path.join(__dirname, "..", "templates", "email", fileName);
  const fileContent = await fs.readFile(filePath);

  const params = {
    Bucket: BUCKET_NAME,
    Key: `email-templates/${fileName}`,
    Body: fileContent,
  };

  try {
    await s3Client.send(new PutObjectCommand(params));
    console.log(`Successfully uploaded ${fileName}`);
  } catch (err) {
    console.error(`Error uploading ${fileName}:`, err);
  }
}

async function uploadAllTemplates() {
  const templateDir = path.join(__dirname, "..", "templates", "email");
  const files = await fs.readdir(templateDir);

  for (const file of files) {
    await uploadTemplate(file);
  }
}

uploadAllTemplates();
