// Pure order pricing. All arithmetic is in integer centavos; nothing here touches the DB.
//
// Per line:  gross = unit price × qty
//            discount = item discount + share of the order-level discount (largest remainder)
//            payable = gross − discount
//            inclusive tax: tax = payable − payable/(1+rate), net = payable − tax, lineTotal = payable
//            exclusive tax: tax = payable × rate,             net = payable,       lineTotal = payable + tax
// Order:     serviceCharge = Σ net × outlet rate;  total = Σ lineTotal + serviceCharge
import { toCents, fromCents, toMilli, roundCents } from "../utils/money.js";

const discountCents = (baseCents, discount) => {
  if (!discount || baseCents <= 0) return 0;
  if (discount.type === "PERCENTAGE") return Math.min(baseCents, roundCents((baseCents * Number(discount.value)) / 100));
  return Math.min(baseCents, toCents(discount.value));
};

// Splits `amount` across `weights` proportionally so the parts always sum to `amount`.
export const allocate = (amount, weights) => {
  const total = weights.reduce((s, w) => s + w, 0);
  if (amount <= 0 || total <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (amount * w) / total);
  const parts = raw.map(Math.floor);
  let remainder = amount - parts.reduce((s, p) => s + p, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; remainder > 0; k = (k + 1) % order.length, remainder--) parts[order[k][1]] += 1;
  return parts;
};

/**
 * @param {Array<{key, unitPrice, quantity, taxRate, taxInclusive, discount?}>} lines  discount = {type, value} item-level
 * @param {{type, value}|null} orderDiscount
 * @param {string|number} serviceChargeRate  percent
 */
export function priceOrder(lines, orderDiscount = null, serviceChargeRate = 0) {
  const work = lines.map((l) => {
    const gross = roundCents((toCents(l.unitPrice) * toMilli(l.quantity)) / 1000);
    const itemDiscount = discountCents(gross, l.discount);
    return { ...l, gross, itemDiscount, afterItem: gross - itemDiscount };
  });

  const baseForOrder = work.reduce((s, l) => s + l.afterItem, 0);
  const orderDiscountTotal = discountCents(baseForOrder, orderDiscount);
  const shares = allocate(orderDiscountTotal, work.map((l) => l.afterItem));

  let net = 0;
  const priced = work.map((l, i) => {
    const discount = l.itemDiscount + shares[i];
    const payable = l.gross - discount;
    const rate = Number(l.taxRate || 0);
    let tax;
    let lineNet;
    let lineTotal;
    if (l.taxInclusive) {
      tax = payable - roundCents(payable / (1 + rate));
      lineNet = payable - tax;
      lineTotal = payable;
    } else {
      tax = roundCents(payable * rate);
      lineNet = payable;
      lineTotal = payable + tax;
    }
    net += lineNet;
    return {
      key: l.key,
      grossAmount: fromCents(l.gross),
      itemDiscountAmount: fromCents(l.itemDiscount),
      orderDiscountShare: fromCents(shares[i]),
      discountAmount: fromCents(discount),
      taxAmount: fromCents(tax),
      netAmount: fromCents(lineNet),
      lineTotal: fromCents(lineTotal),
      _total: lineTotal,
      _tax: tax,
      _discount: discount,
      _gross: l.gross,
    };
  });

  const serviceCharge = roundCents((net * Number(serviceChargeRate || 0)) / 100);
  const sum = (k) => priced.reduce((s, p) => s + p[k], 0);
  return {
    lines: priced.map(({ _total, _tax, _discount, _gross, ...rest }) => rest),
    subtotal: fromCents(sum("_gross")),
    discountAmount: fromCents(sum("_discount")),
    orderDiscountAmount: fromCents(orderDiscountTotal),
    taxAmount: fromCents(sum("_tax")),
    serviceChargeAmount: fromCents(serviceCharge),
    totalAmount: fromCents(sum("_total") + serviceCharge),
  };
}
