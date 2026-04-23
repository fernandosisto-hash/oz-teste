# oz-teste — Runbook operacional

## 1. Objetivo

Subir, validar e operar o `oz-teste` com o mínimo de ambiguidade.

## 2. Presets práticos

### Desenvolvimento rápido
- `NODE_ENV=development`
- `STORAGE_BACKEND=json`
- `DEFAULT_EXECUTION_MODE=local` ou `miguel`
- `API_TOKEN` opcional

### Produção inicial segura
- usar `.env.production`
- `NODE_ENV=production`
- `API_TOKEN` obrigatório
- `DEFAULT_EXECUTION_MODE=miguel`
- `MIGUEL_LOCAL_FALLBACK=false`
- preferir `STORAGE_BACKEND=postgres` quando o ambiente real estiver pronto

## 3. Subida local

```bash
npm install
cp .env.production.example .env.production
# editar credenciais e alvos reais
npm run start:prod
```

## 4. Subida com Docker Compose

```bash
cp .env.production.example .env.production
docker compose -f docker-compose.production.yml up -d --build
```

## 5. Checagem pós-boot

### Health
```bash
curl -s http://localhost:3000/health
```
Esperado:
- `status=ok`
- `checks.storage.ok=true`

### Info
```bash
curl -s http://localhost:3000/info
```
Conferir:
- backend selecionado
- modo default de dispatch
- ordem do miguel

## 6. Auth mínima

Em produção, chamar rotas protegidas com:
- `Authorization: Bearer <API_TOKEN>`
ou
- `X-API-Token: <API_TOKEN>`

## 7. Fluxo operacional mínimo

1. criar task em `/tasks`
2. dispatch em `/tasks/:id/dispatch`
3. acompanhar `/tasks/:id`
4. se `oz`, sync manual em `/tasks/:id/sync` ou `/tasks/sync`
5. consultar notificações em `/tasks/:id/notifications`

## 8. Leitura rápida de falha

### `/health` volta 503
Olhar:
- `checks.storage.error`
- `env.storageBackend`

### Boot falha antes de subir
Provável causa:
- `API_TOKEN` ausente em produção
- default de dispatch incompatível com env real
- `DATABASE_URL` ausente com `STORAGE_BACKEND=postgres`

### Task falha no dispatch
Olhar na própria task:
- `dispatchMode`
- `dispatchMeta`
- `lastError`

## 9. Regras de operação

- `miguel` decide rota, mas não inventa backend disponível
- se `MIGUEL_LOCAL_FALLBACK=false`, o sistema falha fechado
- `cancel` e `timeout` são locais; não abortam run remoto do Oz
- a fonte de verdade do ciclo da task está na própria task + notifications

## 10. Checklist de virada para ambiente real

- definir `API_TOKEN`
- definir backend de storage real
- definir rota real de dispatch (`oz`, `webhook` ou ambos via `miguel`)
- validar `/health`
- criar task de teste
- dispatchar task de teste
- validar notificação final
