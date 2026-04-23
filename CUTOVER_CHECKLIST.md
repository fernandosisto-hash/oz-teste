# oz-teste — checklist de virada

## Antes do push

- confirmar repo local limpo
- confirmar `npm test` verde
- revisar `.env.production` local
- decidir backend real de dispatch (`oz`, `webhook` ou `miguel`)
- decidir storage real (`json` ou `postgres`)

## Push

```bash
git push origin main
```

## Configurar ambiente real

### mínimo
- `NODE_ENV=production`
- `API_TOKEN=<forte>`
- `PORT`
- `LOG_LEVEL=info`

### dispatch
- se `local`: `DEFAULT_EXECUTION_MODE=local`
- se `oz`: `DEFAULT_EXECUTION_MODE=oz` + `WARP_API_KEY`
- se `webhook`: `DEFAULT_EXECUTION_MODE=webhook` + `DISPATCH_WEBHOOK_URL`
- se `miguel`: `DEFAULT_EXECUTION_MODE=miguel` + alvos reais configurados

### storage
- `json`: `DATA_DIR=./data`
- `postgres`: `STORAGE_BACKEND=postgres` + `DATABASE_URL`

## Subir aplicação

### node direto
```bash
npm install
npm run start:prod
```

### docker compose
```bash
docker compose -f docker-compose.production.yml up -d --build
```

## Validar ambiente

### health
```bash
curl -s http://localhost:3000/health
```
Esperado:
- `status=ok`
- `checks.storage.ok=true`

### smoke
```bash
API_TOKEN=... BASE_URL=http://localhost:3000 TASK_MODE=local ./scripts/smoke.sh
```

## Validar dispatch real

### miguel
- criar task com `executionMode=miguel`
- dispatchar
- checar `dispatchMeta.resolvedMode`
- checar `lastError` se houver falha

### oz
- confirmar `runId`
- confirmar `sessionLink`
- rodar sync se necessário

## Fechamento

- guardar URL/base do ambiente
- guardar preset real escolhido
- registrar se ficou em `json` ou `postgres`
- registrar se ficou em `local`, `oz`, `webhook` ou `miguel`
