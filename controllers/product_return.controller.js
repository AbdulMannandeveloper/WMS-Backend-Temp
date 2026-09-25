const productReturnLogic = require('../logic/product_return.logic');
const { holdsPermission } = require('../utils/permissions');

const { redactMoney } = productReturnLogic;

/**
 * The logic sets `status` where it means something specific — 404 for a return
 * or location that is not there, 409 for one already resolved or a parcel that
 * disagrees with its product. Anything else it throws is a refusal of the input.
 */
const fail = (res, error) => {
  const status = error.status || (/not found/i.test(error.message) ? 404 : 400);
  res.status(status).json({ error: error.message });
};

/** Every response goes through here, so no route can forget to strip prices. */
const send = (req, res, status, data) =>
  res.status(status).json(redactMoney(data, req.user?.role));

// Called as each code is scanned, before anything is recorded.
const identify = async (req, res) => {
  try {
    const { tracking, code } = req.query;
    send(req, res, 200, await productReturnLogic.identify({ tracking, code }));
  } catch (err) {
    fail(res, err);
  }
};

const listReturns = async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status) : undefined;
    send(req, res, 200, await productReturnLogic.getReturns({ status }));
  } catch (err) {
    fail(res, err);
  }
};

const getReturn = async (req, res) => {
  try {
    send(req, res, 200, await productReturnLogic.getReturnById(req.params.id));
  } catch (err) {
    fail(res, err);
  }
};

// Book the parcel in. The number, the client and the charges are all worked
// out server-side; only what was scanned and decided is taken from the body.
//
// A disposition sent with it is decided in the same act, so it needs what
// deciding later needs: returns:update, on top of the create the route checks.
const recordReturn = async (req, res) => {
  try {
    const { trackingNumber, productId, quantity, notes, disposition } = req.body || {};
    if (disposition && !holdsPermission(req.user, 'returns', 'update')) {
      return res
        .status(403)
        .json({ error: 'You do not have permission to perform this action.' });
    }
    send(
      req,
      res,
      201,
      await productReturnLogic.recordReturn(
        { trackingNumber, productId, quantity, notes, disposition },
        req.user.id,
      ),
    );
  } catch (err) {
    fail(res, err);
  }
};

// Step 2a: thrown away. No further charge.
const disposeReturn = async (req, res) => {
  try {
    send(
      req,
      res,
      200,
      await productReturnLogic.disposeReturn(
        req.params.id,
        { notes: req.body?.notes },
        req.user.id,
      ),
    );
  } catch (err) {
    fail(res, err);
  }
};

// Step 2b: back on a shelf, and the restock charge raised.
const restockReturn = async (req, res) => {
  try {
    send(
      req,
      res,
      200,
      await productReturnLogic.restockReturn(
        req.params.id,
        { locationId: req.body?.locationId, notes: req.body?.notes },
        req.user.id,
      ),
    );
  } catch (err) {
    fail(res, err);
  }
};

module.exports = {
  identify,
  listReturns,
  getReturn,
  recordReturn,
  disposeReturn,
  restockReturn,
};
