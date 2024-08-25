const AWS = require('aws-sdk');
const fs = require('fs');
const path = require('path');

const s3 = new AWS.S3();
const BUCKET_NAME = `${process.env.ENV}-mashirotheater-templates`;

async function uploadTemplate(fileName) {
  const filePath = path.join(__dirname, '..', 'templates', 'email', fileName);
  const fileContent = fs.readFileSync(filePath);

  const params = {
    Bucket: BUCKET_NAME,
    Key: `email-templates/${fileName}`,
    Body: fileContent
  };

  try {
    await s3.putObject(params).promise();
    console.log(`Successfully uploaded ${fileName}`);
  } catch (err) {
    console.error(`Error uploading ${fileName}:`, err);
  }
}

async function uploadAllTemplates() {
  const templateDir = path.join(__dirname, '..', 'templates', 'email');
  const files = fs.readdirSync(templateDir);

  for (const file of files) {
    await uploadTemplate(file);
  }
}

uploadAllTemplates();