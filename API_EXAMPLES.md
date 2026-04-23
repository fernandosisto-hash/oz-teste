# oz-teste — exemplos rápidos de API

## Auth

```bash
export BASE_URL=http://localhost:3000
export API_TOKEN=seu-token
```

## 1. Health

```bash
curl -s $BASE_URL/health
```

## 2. Criar task

### local
```bash
curl -s -X POST $BASE_URL/tasks \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"teste local","executionMode":"local"}'
```

### miguel
```bash
curl -s -X POST $BASE_URL/tasks \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"teste miguel","executionMode":"miguel","priority":"high"}'
```

## 3. Dispatch

```bash
curl -s -X POST $BASE_URL/tasks/1/dispatch \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{}'
```

## 4. Ver task

```bash
curl -s -H "Authorization: Bearer $API_TOKEN" $BASE_URL/tasks/1
```

## 5. Sync manual de task Oz

```bash
curl -s -X POST $BASE_URL/tasks/1/sync \
  -H "Authorization: Bearer $API_TOKEN"
```

## 6. Sync em lote

```bash
curl -s -X POST $BASE_URL/tasks/sync \
  -H "Authorization: Bearer $API_TOKEN"
```

## 7. Notificações

```bash
curl -s -H "Authorization: Bearer $API_TOKEN" $BASE_URL/notifications
curl -s -H "Authorization: Bearer $API_TOKEN" $BASE_URL/tasks/1/notifications
```

## 8. Smoke test pronto

```bash
API_TOKEN=seu-token BASE_URL=http://localhost:3000 TASK_MODE=local ./scripts/smoke.sh
```
