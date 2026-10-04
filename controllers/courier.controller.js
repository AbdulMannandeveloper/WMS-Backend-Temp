'use strict';

const courierLogic = require('../logic/courier.logic');
const { pick } = require('../utils/pick');
const { dependentsBody } = require('../utils/dependents');

const COURIER_WRITE_FIELDS = ['code', 'name', 'trackingRegex', 'trackingUrlTemplate', 'isActive'];
const DEPOT_WRITE_FIELDS = ['name', 'address', 'isActive'];

const fail = (res, error) => {
  if (error.code === 'HAS_DEPENDENTS') {
    return res.status(409).json(dependentsBody(error));
  }
  const status = error.status || (/not found/i.test(error.message) ? 404 : 400);
  return res.status(status).json({ error: error.message });
};

const actor = (req) => req.user && req.user.id;

/**
 * A client preparing a manifest needs the valid courier codes, but not the
 * regexes or depots. Staff get the full rows.
 */
const listCouriers = async (req, res) => {
  try {
    const activeOnly = req.query.active === 'true';
    const couriers = await courierLogic.listCouriers({ activeOnly });
    if (req.user?.role === 'client') {
      return res
        .status(200)
        .json(couriers.map(({ id, code, name }) => ({ id, code, name })));
    }
    return res.status(200).json(couriers);
  } catch (error) {
    return fail(res, error);
  }
};

const createCourier = async (req, res) => {
  try {
    const data = pick(req.body, COURIER_WRITE_FIELDS);
    return res.status(201).json(await courierLogic.createCourier(data, actor(req)));
  } catch (error) {
    return fail(res, error);
  }
};

const updateCourier = async (req, res) => {
  try {
    const data = pick(req.body, COURIER_WRITE_FIELDS);
    return res.status(200).json(await courierLogic.updateCourier(req.params.id, data, actor(req)));
  } catch (error) {
    return fail(res, error);
  }
};

const getCourierDependents = async (req, res) => {
  try {
    const { report } = await courierLogic.getCourierDependents(req.params.id);
    return res.status(200).json(report);
  } catch (error) {
    return fail(res, error);
  }
};

const deleteCourier = async (req, res) => {
  try {
    return res.status(200).json(await courierLogic.deleteCourier(req.params.id, actor(req)));
  } catch (error) {
    return fail(res, error);
  }
};

const addDepot = async (req, res) => {
  try {
    const data = pick(req.body, DEPOT_WRITE_FIELDS);
    return res.status(201).json(await courierLogic.addDepot(req.params.id, data, actor(req)));
  } catch (error) {
    return fail(res, error);
  }
};

const updateDepot = async (req, res) => {
  try {
    const data = pick(req.body, DEPOT_WRITE_FIELDS);
    return res
      .status(200)
      .json(await courierLogic.updateDepot(req.params.depotId, data, actor(req)));
  } catch (error) {
    return fail(res, error);
  }
};

const deleteDepot = async (req, res) => {
  try {
    return res.status(200).json(await courierLogic.deleteDepot(req.params.depotId, actor(req)));
  } catch (error) {
    return fail(res, error);
  }
};

module.exports = {
  listCouriers,
  createCourier,
  updateCourier,
  getCourierDependents,
  deleteCourier,
  addDepot,
  updateDepot,
  deleteDepot,
};
