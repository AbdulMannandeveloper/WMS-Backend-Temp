const serviceRepository = require("../repositories/service.repository");
const auditLogLogic = require("./audit_log.logic");
const { prisma } = require("../lib/prisma");
const { buildReport, assertDeletable } = require("../utils/dependents");

/**
 * What an admin may change on a catalogue entry.
 *
 * `code` is absent on purpose: it is how billing finds the services it raises
 * by itself (logic/billing_services.js), and a request body that could set or
 * clear it could detach dispatch charging from its rates.
 */
const SERVICE_UPDATE_FIELDS = ["description", "ideaPrice", "unit"];

const addNewService = async (serviceData) => {
  if (serviceData.ideaPrice < 0) {
    throw new Error("Service price cannot be negative");
  }

  return await serviceRepository.createServiceEntry(serviceData);
};

const getAllServices = async () => {
  return await serviceRepository.getAllServices();
};

const getServiceById = async (id) => {
  return await serviceRepository.getServiceById(id);
};

const updateService = async (id, rawServiceData) => {
  const serviceData = {};
  for (const field of SERVICE_UPDATE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(rawServiceData, field)) {
      serviceData[field] = rawServiceData[field];
    }
  }

  if (serviceData.ideaPrice < 0) {
    throw new Error("Service price cannot be negative");
  }

  return await serviceRepository.updateService(id, serviceData);
};

/**
 * Everything that still refers to a service, for the warning shown before a
 * delete. See utils/dependents.js for what blocking and removedWith mean.
 *
 * Shipments and bulk shipments that carry the service block it (the FK is
 * Restrict). Agreed client rates go with it — the FK cascades — which is worth
 * saying out loud, since it is a client's negotiated price disappearing.
 * Invoices already raised keep their lines; only the link back to the rate is
 * cleared.
 *
 * A service the system raises by itself (it has a `code`) is never deletable:
 * billing would recreate it on next use, at a list price of zero, with every
 * client's agreed rate gone.
 */
const getServiceDependents = async (id) => {
  const service = await serviceRepository.getServiceById(id);
  if (!service) {
    const err = new Error("Service not found");
    err.status = 404;
    throw err;
  }

  const [shipments, fbaShipments, clientRates] = await Promise.all([
    prisma.shipmentServiceMapping.count({ where: { serviceId: id } }),
    prisma.fbaShipmentService.count({ where: { serviceId: id } }),
    prisma.clientService.count({ where: { serviceId: id } }),
  ]);

  return {
    service,
    report: buildReport({
      blocking: [
        {
          key: "system",
          label: "Raised automatically by billing",
          count: service.code ? 1 : 0,
          note: "Built-in services cannot be deleted. Rename or reprice it instead.",
        },
        {
          key: "shipments",
          label: "Shipments charged for it",
          count: shipments,
          where: "/shipments",
          note: "Remove the service from those shipments, or delete them.",
        },
        {
          key: "fbaShipments",
          label: "Bulk shipments charged for it",
          count: fbaShipments,
          where: "/fba",
          note: "Remove the service from those bulk shipments, or delete them.",
        },
      ],
      removedWith: [
        {
          key: "clientRates",
          label: "Agreed client rates",
          count: clientRates,
          where: "/clients",
          note: "Invoices already raised keep their lines.",
        },
      ],
    }),
  };
};

/**
 * @throws {HasDependentsError} (409) while anything in getServiceDependents blocks
 */
const deleteService = async (id, actorUserId) => {
  const { service, report } = await getServiceDependents(id);
  assertDeletable(service.description, report);

  await serviceRepository.deleteService(id);

  if (actorUserId) {
    await auditLogLogic
      .createAuditLog(actorUserId, "DELETE_SERVICE", {
        serviceId: id,
        description: service.description,
        clientRatesRemoved: report.removedWith[0]?.count ?? 0,
      })
      .catch((err) => console.error("Audit log error:", err.message));
  }

  return service;
};

module.exports = {
  addNewService,
  getAllServices,
  getServiceById,
  updateService,
  getServiceDependents,
  deleteService,
};
