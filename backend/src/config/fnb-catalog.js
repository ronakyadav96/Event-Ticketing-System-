// Food & beverage items sold with tickets on the web booking page. Prices are decided here,
// never by the client; frontend/src/app/pages/booking-page mirrors this list for display
// and reads it from GET /api/payments/fnb-catalog.
const FNB_CATALOG = [
  { id: 'fnb1', name: 'Caramel Popcorn + Coke Combo', category: 'Combos', price: 340 },
  { id: 'fnb2', name: 'Salted Large Popcorn', category: 'Snacks', price: 260 },
  { id: 'fnb3', name: 'Cheesy Nachos with Salsa', category: 'Snacks', price: 220 },
  { id: 'fnb4', name: 'Chilled Pepsi 500ml', category: 'Beverages', price: 150 },
];

const MAX_QTY_PER_ITEM = 10;

// selection: { [itemId]: quantity }. Returns priced line items in paise, or an error message.
function priceFnbSelection(selection) {
  if (selection == null) return { ok: true, items: [], totalPaise: 0 };
  if (typeof selection !== 'object' || Array.isArray(selection)) {
    return { ok: false, message: 'fnb must be an object of { itemId: quantity }.' };
  }

  const items = [];
  for (const [id, rawQty] of Object.entries(selection)) {
    const quantity = Number(rawQty);
    if (quantity === 0) continue;
    const item = FNB_CATALOG.find((i) => i.id === id);
    if (!item) return { ok: false, message: `Unknown food item: ${id}` };
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > MAX_QTY_PER_ITEM) {
      return { ok: false, message: `Invalid quantity for ${item.name}.` };
    }
    items.push({ id: item.id, name: item.name, quantity, unitAmount: item.price * 100 });
  }

  const totalPaise = items.reduce((sum, i) => sum + i.unitAmount * i.quantity, 0);
  return { ok: true, items, totalPaise };
}

module.exports = { FNB_CATALOG, priceFnbSelection };
