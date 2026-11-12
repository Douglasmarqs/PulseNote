const DEFAULT_TIME_ZONE = "America/Sao_Paulo";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asMoney(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
}

function validIsoDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function validTimeZone(value) {
  try {
    new Intl.DateTimeFormat("pt-BR", { timeZone: value }).format();
    return value;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

function localIso(now, requestedTimeZone) {
  const timeZone = validTimeZone(requestedTimeZone || DEFAULT_TIME_ZONE);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDays(iso, days) {
  const date = new Date(`${iso}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function endOfMonth(iso) {
  const [year, month] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function workspaceIdOf(item) {
  return typeof item?.workspaceId === "string" && item.workspaceId.trim()
    ? item.workspaceId.trim()
    : "personal";
}

function inWorkspace(item, workspaceId) {
  return workspaceIdOf(item) === workspaceId;
}

function accountBalance(state, workspaceId, today) {
  const accounts = asArray(state.financeAccounts).filter((item) => inWorkspace(item, workspaceId) && item.archived !== true);
  const authoritative = accounts.filter((item) => Number.isFinite(Number(item.currentBalance ?? item.balance)));
  if (authoritative.length) {
    return {
      amount: authoritative.reduce((sum, item) => sum + asMoney(item.currentBalance ?? item.balance), 0),
      source: "accounts",
      accountCount: authoritative.length,
    };
  }

  const entries = asArray(state.finances).filter((item) =>
    inWorkspace(item, workspaceId) && validIsoDate(item.date) && item.date <= today
  );
  return {
    amount: entries.reduce((sum, item) => sum + (item.type === "receita" ? asMoney(item.amount) : -asMoney(item.amount)), 0),
    source: "transactions",
    accountCount: accounts.length,
  };
}

function materializedRecurring(state, item, monthKey) {
  return asArray(state.finances).some((entry) =>
    entry.date?.startsWith(monthKey)
    && entry.description === item.description
    && asMoney(entry.amount) === asMoney(item.amount)
    && workspaceIdOf(entry) === workspaceIdOf(item)
  );
}

function recurringOccurrences(state, workspaceId, fromIso, toIso) {
  const output = [];
  const cursor = new Date(`${fromIso.slice(0, 7)}-01T12:00:00.000Z`);
  const lastMonth = toIso.slice(0, 7);

  while (cursor.toISOString().slice(0, 7) <= lastMonth) {
    const monthKey = cursor.toISOString().slice(0, 7);
    const [year, month] = monthKey.split("-").map(Number);
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    for (const item of asArray(state.finRecurrents)) {
      if (!inWorkspace(item, workspaceId) || item.active === false) continue;
      if (asArray(item.skippedMonths).includes(monthKey)) continue;
      if (materializedRecurring(state, item, monthKey)) continue;
      const day = Math.max(1, Math.min(days, Number(item.day) || 1));
      const date = `${monthKey}-${String(day).padStart(2, "0")}`;
      if (date < fromIso || date > toIso) continue;
      output.push({
        id: item.id || `${monthKey}:${item.description}:${day}`,
        date,
        description: String(item.description || "Lançamento recorrente").slice(0, 80),
        amount: asMoney(item.amount),
        type: item.type === "receita" ? "receita" : "despesa",
        source: "recurring",
      });
    }
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return output;
}

function scheduledOccurrences(state, workspaceId, fromIso, toIso) {
  return asArray(state.scheduledFinances)
    .filter((item) => inWorkspace(item, workspaceId) && validIsoDate(item.date) && item.date >= fromIso && item.date <= toIso && item.status !== "cancelled")
    .map((item) => ({
      id: item.id,
      date: item.date,
      description: String(item.description || "Lançamento agendado").slice(0, 80),
      amount: asMoney(item.amount),
      type: item.type === "receita" ? "receita" : "despesa",
      source: "scheduled",
    }));
}

function cardBillOccurrences(state, workspaceId, fromIso, toIso) {
  return asArray(state.creditCards).flatMap((card) => {
    if (!inWorkspace(card, workspaceId) || card.archived === true) return [];
    return asArray(card.invoices)
      .filter((invoice) => validIsoDate(invoice.dueDate) && invoice.dueDate >= fromIso && invoice.dueDate <= toIso && invoice.status !== "paid")
      .map((invoice) => ({
        id: invoice.id || `${card.id}:${invoice.dueDate}`,
        date: invoice.dueDate,
        description: `Fatura ${String(card.name || "do cartão").slice(0, 54)}`,
        amount: asMoney(invoice.amount),
        type: "despesa",
        source: "card",
      }));
  });
}

function money(value) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(asMoney(value));
}

function buildFinanceForecast(state = {}, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  if (!Number.isFinite(now.getTime())) throw new TypeError("invalid_now");
  const workspaceId = typeof options.workspaceId === "string" && options.workspaceId.trim()
    ? options.workspaceId.trim()
    : (state.activeWorkspaceId || "personal");
  const today = localIso(now, state.timeZone);
  const horizonDate = validIsoDate(options.horizonDate) && options.horizonDate >= today
    ? options.horizonDate
    : endOfMonth(today);
  const firstFutureDay = addDays(today, 1);
  const starting = accountBalance(state, workspaceId, today);
  const commitments = [
    ...recurringOccurrences(state, workspaceId, firstFutureDay, horizonDate),
    ...scheduledOccurrences(state, workspaceId, firstFutureDay, horizonDate),
    ...cardBillOccurrences(state, workspaceId, firstFutureDay, horizonDate),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.description.localeCompare(b.description));

  const reserve = Math.max(0, asMoney(options.reserve ?? state.financialSettings?.safetyReserve));
  const purchaseAmount = Math.max(0, asMoney(options.purchaseAmount));
  const purchaseDate = validIsoDate(options.purchaseDate) && options.purchaseDate >= today && options.purchaseDate <= horizonDate
    ? options.purchaseDate
    : today;
  const timeline = [{ date: today, balance: starting.amount, kind: "current" }];
  let running = starting.amount;
  let lowestBalance = running;
  let lowestBalanceDate = today;
  let purchaseApplied = false;

  for (const commitment of commitments) {
    if (!purchaseApplied && purchaseAmount > 0 && purchaseDate <= commitment.date) {
      running -= purchaseAmount;
      timeline.push({ date: purchaseDate, balance: running, kind: "simulation", description: "Compra simulada" });
      purchaseApplied = true;
    }
    running += commitment.type === "receita" ? commitment.amount : -commitment.amount;
    timeline.push({ ...commitment, balance: running, kind: commitment.source });
    if (running < lowestBalance) {
      lowestBalance = running;
      lowestBalanceDate = commitment.date;
    }
  }
  if (!purchaseApplied && purchaseAmount > 0) {
    running -= purchaseAmount;
    timeline.push({ date: purchaseDate, balance: running, kind: "simulation", description: "Compra simulada" });
    if (running < lowestBalance) {
      lowestBalance = running;
      lowestBalanceDate = purchaseDate;
    }
  }

  const daysRemaining = Math.max(1, Math.round((new Date(`${horizonDate}T12:00:00Z`) - new Date(`${today}T12:00:00Z`)) / 86400000));
  const safeToSpend = Math.max(0, lowestBalance - reserve + purchaseAmount);
  const afterPurchase = running;
  const canAfford = purchaseAmount === 0 ? null : lowestBalance >= reserve;
  const confidence = starting.source === "accounts"
    ? (commitments.length ? "high" : "medium")
    : "low";
  const reasons = [];
  if (starting.source !== "accounts") reasons.push("Cadastre o saldo atual das contas para uma projeção mais precisa.");
  if (!commitments.length) reasons.push("Nenhuma conta, fatura ou recorrência futura foi encontrada até o fim do período.");
  if (reserve === 0) reasons.push("Defina uma reserva mínima para o valor seguro respeitar sua margem pessoal.");

  return {
    workspaceId,
    today,
    horizonDate,
    currentBalance: starting.amount,
    projectedBalance: running + purchaseAmount,
    projectedBalanceAfterPurchase: afterPurchase,
    safeToSpend,
    dailySafeToSpend: Math.max(0, safeToSpend / daysRemaining),
    reserve,
    purchaseAmount,
    purchaseDate,
    canAfford,
    lowestBalance,
    lowestBalanceDate,
    commitments,
    timeline,
    confidence,
    reasons,
    summary: purchaseAmount > 0
      ? (canAfford
        ? `Essa compra de ${money(purchaseAmount)} cabe na projeção e preserva ${money(reserve)} de reserva.`
        : `Essa compra de ${money(purchaseAmount)} faria o saldo mínimo cair para ${money(lowestBalance)}, abaixo da reserva de ${money(reserve)}.`)
      : `Até ${horizonDate}, a projeção fecha em ${money(running)} e o valor disponível com segurança é ${money(safeToSpend)}.`,
  };
}

module.exports = {
  buildFinanceForecast,
  localIso,
  workspaceIdOf,
};
