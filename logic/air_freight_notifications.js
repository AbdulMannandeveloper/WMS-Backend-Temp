'use strict';

/**
 * Opt-in client emails for air freight milestones and exceptions.
 *
 * A milestone email is sent at most once per flight: the milestone name is
 * claimed atomically with an array_append guarded by NOT (… = ANY(…)), so two
 * concurrent requests cannot both send. Everything here runs after the caller's
 * transaction has committed and is wrapped so a mail failure only logs — a client
 * notification must never roll back the warehouse action that triggered it.
 */

const { prisma } = require('../lib/prisma');
const { getSettings } = require('./air_freight_settings.logic');
const { enqueueMail } = require('../utils/mailQueue');
const { airFreightMilestoneEmailTemplate, airFreightExceptionEmailTemplate } = require('../utils/emailTemplates');

const portalUrl = () => process.env.APP_BASE_URL || process.env.PORTAL_URL || '';

const recipientFor = async (flight, settings) => {
  if (settings.notificationEmail) return settings.notificationEmail;
  const client = await prisma.client.findUnique({ where: { id: flight.clientId }, select: { email: true } });
  return client?.email ?? null;
};

/**
 * Sends a milestone email once, if the client opted in.
 * @param {string} flightId
 * @param {string} milestone  DISPATCHED | LANDED | CUSTOMS_HOLD | CLEARED | RECEIPT_CLOSED | COMPLETED
 * @param {object} [extra]  e.g. { shortCount }
 */
const notifyMilestone = async (flightId, milestone, extra = {}) => {
  try {
    const flight = await prisma.airFreightFlight.findUnique({
      where: { id: flightId },
      select: { id: true, reference: true, clientId: true, mawbNumber: true, originLocation: true, destinationLocation: true },
    });
    if (!flight) return;
    const settings = await getSettings(flight.clientId);
    if (!settings.emailNotifications) return;

    const claimed = await prisma.$executeRaw`
      UPDATE air_freight_flights
      SET notified_milestones = array_append(notified_milestones, ${milestone})
      WHERE id = ${flightId}::uuid AND NOT (${milestone} = ANY(notified_milestones))`;
    if (claimed !== 1) return;

    const to = await recipientFor(flight, settings);
    if (!to) return;
    const client = await prisma.client.findUnique({ where: { id: flight.clientId }, select: { companyName: true } });
    const { subject, text, html } = airFreightMilestoneEmailTemplate({
      companyName: client?.companyName ?? 'Customer', flight, milestone, shortCount: extra.shortCount ?? 0, portalUrl: portalUrl(),
    });
    enqueueMail({ to, subject, text, html });
  } catch (err) {
    console.error('[air-freight] milestone email failed:', err.message);
  }
};

/** Emails the client that an exception needs their decision (not deduplicated). */
const notifyExceptionAwaitingClient = async (exceptionId) => {
  try {
    const exc = await prisma.airFreightException.findUnique({
      where: { id: exceptionId },
      select: { id: true, type: true, clientNote: true, flight: { select: { id: true, reference: true, clientId: true } } },
    });
    if (!exc || !exc.flight) return;
    const settings = await getSettings(exc.flight.clientId);
    if (!settings.emailNotifications) return;
    const to = await recipientFor(exc.flight, settings);
    if (!to) return;
    const client = await prisma.client.findUnique({ where: { id: exc.flight.clientId }, select: { companyName: true } });
    const { subject, text, html } = airFreightExceptionEmailTemplate({
      companyName: client?.companyName ?? 'Customer', flight: exc.flight, exceptionType: exc.type, clientNote: exc.clientNote, portalUrl: portalUrl(),
    });
    enqueueMail({ to, subject, text, html });
  } catch (err) {
    console.error('[air-freight] exception email failed:', err.message);
  }
};

module.exports = { notifyMilestone, notifyExceptionAwaitingClient };
