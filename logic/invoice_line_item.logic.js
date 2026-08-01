const invoiceLineItemRepository = require("../repositories/invoice_line_item.repository");

const monthlyInvoiceLogic = require("./monthly_invoice.logic");

const createInvoiceLineItem = async (data) => {
  // Check for required fields
  if (!data.invoiceId || !data.quantity || !data.unitPrice) {
    throw new Error(
      "Monthly Invoice ID, quantity, and unit price are required to create an invoice line item.",
    );
  }
  // Check if the monthly invoice exists
  const monthlyInvoice = await monthlyInvoiceLogic.getMonthlyInvoiceById(
    data.invoiceId,
  );
  if (!monthlyInvoice) {
    throw new Error("Monthly invoice not found.");
  }
  if (data.quantity <= 0) {
    throw new Error("Quantity must be greater than zero.");
  }
  if (data.unitPrice < 0) {
    throw new Error("Unit price cannot be negative.");
  }
  if (!data.description) {
    data.description = "No description provided"; // Default description if not provided
  }
  if (!data.dateOfService) {
    data.dateOfService = new Date(); // Default to current date if not provided
  }

  if (!data.itemType) {
    data.itemType = "AUTOMATED_SERVICE"; // Default item type if not provided
  }

  // Calculate the total price for the line item based on quantity and unit price
  if (!data.totalPrice) {
    data.totalPrice = data.quantity * data.unitPrice;
  }

  const invoiceLineItem =
    await invoiceLineItemRepository.createInvoiceLineItem(data);

  // After creating the invoice line item, we can also update the total amount
  // on the monthly invoice to reflect the new line item. This ensures that the
  // monthly invoice always has an accurate total amount based on its associated line items.
  await monthlyInvoiceLogic.updateMonthlyInvoice(monthlyInvoice.id, {
    amountToAdjust: invoiceLineItem.totalPrice,
  });
  return invoiceLineItem;
};

const getInvoiceLineItemsByField = async (field, value) => {
  return await invoiceLineItemRepository.getInvoiceLineItemsByField(
    field,
    value,
  );
};

const updateInvoiceLineItem = async (id, data) => {
  return await invoiceLineItemRepository.updateInvoiceLineItem(id, data);
};

const deleteInvoiceLineItem = async (id) => {
  // Fetch the line item first so we can reverse its amount from the invoice total
  const lineItem = await invoiceLineItemRepository.getInvoiceLineItemsByField("id", id);
  const item = Array.isArray(lineItem) ? lineItem[0] : lineItem;

  if (!item) {
    throw new Error("Invoice line item not found.");
  }

  // Reverse the line item's contribution to the invoice total
  await monthlyInvoiceLogic.updateMonthlyInvoice(item.invoiceId, {
    amountToAdjust: -Number(item.totalPrice),
  });

  return await invoiceLineItemRepository.deleteInvoiceLineItem(id);
};

module.exports = {
  createInvoiceLineItem,
  getInvoiceLineItemsByField,
  updateInvoiceLineItem,
  deleteInvoiceLineItem,
};
