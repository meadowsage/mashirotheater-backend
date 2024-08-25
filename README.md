## エラーコード体系

- E001: 残席数不足
- E002: 無効な入力データ
- E003: 予約がキャンセル済
- E004: 同一スケジュールに対する重複予約
- E005: 同一公演に対する予約数上限到達
- E999: 内部サーバーエラー

## デプロイ

```
serverless deploy --stage dev --verbose
```

```
serverless deploy --stage dev --verbose
```

```
ENV=dev npm run upload-templates
```

```
ENV=prod npm run upload-templates
```
