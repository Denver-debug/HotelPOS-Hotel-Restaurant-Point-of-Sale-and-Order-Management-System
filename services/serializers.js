// The JSON shape of every resource the API returns. Conventions (see docs/API.md):
//  - money is a decimal string with 2 places ("850.00"), quantities a string with up to 3
//  - timestamps are ISO-8601 instants (UTC "Z"); business dates follow APP_TIMEZONE
//  - ids are numbers; *Number fields are the human document numbers (ORD-…, PAY-…)
//  - guest/room/folio data is only the PMS's external ids, never names
const plain = (row) => (row && typeof row.get === "function" ? row.get({ plain: true }) : row);
const ref = (u) => (u ? { id: u.id ?? null, fullName: u.fullName } : null);
const bool = (v) => (v === null || v === undefined ? v : Boolean(Number(v)));

export const outlet = (row) => {
  const o = plain(row);
  return {
    id: o.id, code: o.code, name: o.name, outletType: o.outletType, location: o.location ?? null, status: o.status,
    allowsRoomCharge: bool(o.allowsRoomCharge), serviceChargeRate: o.serviceChargeRate, createdAt: o.createdAt, updatedAt: o.updatedAt,
  };
};

export const category = (row) => {
  const c = plain(row);
  return { id: c.id, name: c.name, description: c.description ?? null, sortOrder: c.sortOrder, status: c.status, updatedAt: c.updatedAt };
};

export const paymentMethod = (row) => {
  const m = plain(row);
  return { id: m.id, code: m.code, name: m.name, isCash: bool(m.isCash), usesGateway: bool(m.usesGateway), requiresReference: bool(m.requiresReference), sortOrder: m.sortOrder, status: m.status };
};

export const product = (row) => {
  const p = plain(row);
  return {
    id: p.id, code: p.code, name: p.name, description: p.description ?? null, itemType: p.itemType, unit: p.unit, status: p.status,
    isInventoryTracked: bool(p.isInventoryTracked),
    category: p.category ? { id: p.category.id, name: p.category.name } : { id: p.categoryId },
    tax: p.tax ? { code: p.tax.code, rate: p.tax.rate, isInclusive: bool(p.tax.isInclusive) } : null,
    // Current price per outlet (only outlets the caller may see).
    prices: (p.prices || []).map((pr) => ({ outletId: pr.outletId, price: pr.price, isAvailable: bool(pr.isAvailable), effectiveFrom: pr.effectiveFrom })),
    createdAt: p.createdAt, updatedAt: p.updatedAt,
  };
};

export const payment = (row) => {
  const p = plain(row);
  return {
    id: p.id, paymentNumber: p.paymentNumber, orderId: p.orderId, orderNumber: p.order?.orderNumber ?? null, outletId: p.order?.outletId ?? null,
    shiftId: p.shiftId ?? null, method: p.method ? { id: p.paymentMethodId, code: p.method.code, name: p.method.name } : { id: p.paymentMethodId },
    amount: p.amount, tenderedAmount: p.tenderedAmount ?? null, changeAmount: p.changeAmount, refundedAmount: p.refundedAmount,
    status: p.status, reference: p.reference ?? null, gateway: p.gateway ?? null, externalTransactionId: p.externalTransactionId ?? null,
    isMock: bool(p.isMock), failureReason: p.failureReason ?? null, processedBy: ref(p.processor) ?? { id: p.processedBy },
    capturedAt: p.capturedAt ?? null, createdAt: p.createdAt, updatedAt: p.updatedAt,
  };
};

export const guestCharge = (row) => {
  const g = plain(row);
  return {
    id: g.id, chargeNumber: g.chargeNumber, orderId: g.orderId, orderNumber: g.order?.orderNumber ?? null, outletId: g.order?.outletId ?? null,
    roomNumber: g.roomNumber, externalGuestId: g.externalGuestId, externalRoomId: g.externalRoomId, externalFolioId: g.externalFolioId,
    amount: g.amount, reversedAmount: g.reversedAmount, status: g.status, pmsTransactionId: g.pmsTransactionId ?? null,
    attempts: g.attempts, lastError: g.lastError ?? null, isMock: bool(g.isMock), requestedBy: ref(g.requester) ?? { id: g.requestedBy },
    postedAt: g.postedAt ?? null, createdAt: g.createdAt, updatedAt: g.updatedAt,
  };
};

export const refund = (row) => {
  const r = plain(row);
  return {
    id: r.id, refundNumber: r.refundNumber, orderId: r.orderId, orderNumber: r.order?.orderNumber ?? null, outletId: r.order?.outletId ?? null,
    refundType: r.refundType, settlementType: r.settlementType, amount: r.amount, reason: r.reason, status: r.status, restock: bool(r.restock),
    refundMethod: r.refundMethod ? { id: r.refundMethod.id, code: r.refundMethod.code, name: r.refundMethod.name } : r.refundMethodId ? { id: r.refundMethodId } : null,
    paymentId: r.paymentId ?? null, guestChargeId: r.guestChargeId ?? null, shiftId: r.shiftId ?? null, externalReference: r.externalReference ?? null,
    items: r.items ? r.items.map((i) => ({ orderItemId: i.orderItemId, productName: i.orderItem?.productName ?? null, quantity: i.quantity, amount: i.amount, restock: bool(i.restock) })) : undefined,
    requestedBy: ref(r.requester), approvedBy: ref(r.approver), approvedAt: r.approvedAt ?? null,
    processedAt: r.processedAt ?? null, rejectionReason: r.rejectionReason ?? null, failureReason: r.failureReason ?? null,
    createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
};

export const receipt = (row) => {
  const r = plain(row);
  return {
    id: r.id, receiptNumber: r.receiptNumber, receiptType: r.receiptType, orderId: r.orderId, refundId: r.refundId ?? null,
    printCount: r.printCount, lastPrintedAt: r.lastPrintedAt ?? null, generatedAt: r.generatedAt, snapshot: r.snapshot,
  };
};

export const shift = (row, summary) => {
  const s = plain(row);
  return {
    id: s.id, shiftNumber: s.shiftNumber, outletId: s.outletId, outlet: s.outlet ? { code: s.outlet.code, name: s.outlet.name } : undefined,
    cashier: ref(s.cashier) ?? { id: s.userId }, status: s.status, openedAt: s.openedAt, closedAt: s.closedAt ?? null,
    openingCash: s.openingCash, expectedCash: s.expectedCash ?? null, actualCash: s.actualCash ?? null, cashVariance: s.cashVariance ?? null,
    openingNotes: s.openingNotes ?? null, closingNotes: s.closingNotes ?? null, reconciledAt: s.reconciledAt ?? null,
    summary: summary ?? undefined, createdAt: s.createdAt, updatedAt: s.updatedAt,
  };
};

// Raw rows from inventoryService.stockLevels().
export const stockLevel = (r) => ({
  id: r.id, outletId: r.outlet_id, outletCode: r.outlet_code, item: { id: r.item_id, sku: r.sku, name: r.name, unit: r.unit },
  quantity: String(r.quantity), reorderLevel: String(r.reorder_level), allowNegative: bool(r.allow_negative), isLow: bool(r.is_low), updatedAt: r.updated_at,
});

export const movement = (row) => {
  const t = plain(row);
  return {
    id: t.id, transactionNumber: t.transactionNumber, type: t.transactionType,
    item: t.item ? { id: t.item.id, sku: t.item.sku, name: t.item.name, unit: t.item.unit } : { id: t.inventoryItemId },
    outletId: t.location?.outletId ?? null, stockLocationId: t.stockLocationId, quantity: t.quantity, balanceAfter: t.balanceAfter,
    unitCost: t.unitCost ?? null, reason: t.reason ?? null, referenceType: t.referenceType ?? null, referenceId: t.referenceId ?? null,
    createdBy: t.createdBy ? { id: t.createdBy, fullName: t.user?.fullName ?? null } : null, createdAt: t.createdAt,
  };
};
