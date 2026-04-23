# Contrato da camada MiguelAntônio no oz-teste

## 1. Papel da camada

A camada MiguelAntônio fica entre a intenção de execução e o backend real de dispatch.

Ela serve para:
- escolher rota de execução
- registrar por que escolheu
- deixar trilha auditável
- expor estado suficiente para operador humano ou sistema acima consumir

Não serve para:
- esconder falha de infraestrutura
- fingir sucesso quando não há backend pronto
- substituir regra de negócio externa

## 2. Entrada mínima

Payload de criação de task:

```json
{
  "title": "string",
  "description": "string|null",
  "executionMode": "local|webhook|oz|miguel",
  "priority": "low|normal|high",
  "timeoutMs": 60000,
  "maxRetries": 3
}
```

## 3. Estados da task

Estados locais válidos:
- `received`
- `in_progress`
- `done`
- `failed`
- `cancelled`

`pending` existe só por compatibilidade legada.

## 4. Contrato do roteamento Miguel

Quando `executionMode=miguel`, o sistema resolve um `dispatchMode` final com base em:
- `DEFAULT_EXECUTION_MODE`
- `MIGUEL_DISPATCH_ORDER`
- disponibilidade real de `oz`, `webhook` e `local`

Saída esperada na task:

```json
{
  "dispatchMode": "oz|webhook|local|null",
  "dispatchMeta": {
    "orchestrator": "miguel",
    "requestedMode": "miguel",
    "resolvedMode": "oz|webhook|local|null",
    "selectedBy": "request.mode|task.executionMode|config.defaultExecutionMode",
    "route": ["oz", "webhook", "local"],
    "fallbackUsed": true,
    "reason": "texto curto",
    "availability": {
      "oz": { "available": false, "reason": "warp_api_key_missing" },
      "webhook": { "available": true, "reason": "dispatch_webhook_url_configured" },
      "local": { "available": false, "reason": "miguel_local_fallback_disabled" }
    },
    "candidates": [
      { "mode": "oz", "available": false, "reason": "warp_api_key_missing" },
      { "mode": "webhook", "available": true, "reason": "dispatch_webhook_url_configured" }
    ],
    "decidedAt": "ISO-8601"
  }
}
```

## 5. Regras de decisão

### Caso 1 — modo direto
Se `executionMode=oz|webhook|local`, a camada só registra decisão direta.

### Caso 2 — modo miguel com alvo disponível
Resolve para o primeiro alvo disponível da ordem configurada.

### Caso 3 — modo miguel sem alvo disponível
- `dispatchMode = null`
- task vai para `failed`
- `lastError` explica que não havia target disponível
- isso é comportamento correto

## 6. Contrato de observabilidade

### `/health`
Tem que dizer:
- status geral
- saúde do storage
- preset ativo de dispatch

### `/info`
Tem que dizer:
- resumo de env
- checks
- capacidades de dispatch

### logs mínimos
Eventos relevantes:
- `dispatch_selected`
- `dispatch_finished`
- `dispatch_unresolved`
- `http_request`

## 7. Contrato de sync

Se `dispatchMode=oz` e a task estiver `in_progress`:
- `/tasks/:id/sync` tenta reconciliar uma task
- `/tasks/sync` reconcilia lote ordenado por prioridade

Persistir na task:
- `runState`
- `sessionLink`
- `resultSummary`
- `completedAt`
- `finishedAt`
- `lastError` quando houver

## 8. Contrato de notificação terminal

Quando a task fecha em `done|failed|cancelled`:
- persistir evento em notifications
- tentar webhook se configurado
- não duplicar emissão para o mesmo status terminal

## 9. O que a camada acima pode assumir

Quem consome o `oz-teste` pode assumir que:
- toda decisão relevante de dispatch vira dado persistido
- estado terminal vem com trilha mínima de erro/resultado
- health e info expõem condição operacional suficiente para diagnóstico rápido

## 10. Próxima camada lógica

O próximo passo acima deste contrato é uma camada de negócio que faça:
- intake semântico
- tradução de intenção humana para task
- classificação/priorização automática
- política de retry/escalation por tipo de trabalho
- feedback ao operador humano

## 11. Exemplos operacionais rápidos

### Criar task em modo miguel

```bash
curl -s -X POST http://localhost:3000/tasks \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"rodar rotina","executionMode":"miguel","priority":"high"}'
```

### Ler a decisão tomada

Campos para olhar na task:
- `dispatchMode`
- `dispatchMeta.resolvedMode`
- `dispatchMeta.fallbackUsed`
- `dispatchMeta.reason`
- `dispatchMeta.availability`

### Interpretar rápido

- `resolvedMode=oz` → foi para Warp/Oz
- `resolvedMode=webhook` → caiu no integrador HTTP
- `resolvedMode=local` → executou no fallback local
- `resolvedMode=null` → falhou fechado por falta de target disponível
