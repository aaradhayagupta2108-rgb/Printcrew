/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║   PrintCrew Backend — server.js                          ║
 * ║   Node.js · Express · Razorpay · Firebase Admin         ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 * DEPLOY ON RAILWAY:
 *   1. Push this file + package.json to a GitHub repo
 *   2. Connect repo to railway.app → new project
 *   3. Set environment variables in Railway dashboard
 *   4. Railway auto-deploys on every git push
 *
 * REQUIRED ENVIRONMENT VARIABLES (set in Railway dashboard):
 *   RZP_KEY_ID              — rzp_live_SUFAME4O5y5qdy
 *   RZP_KEY_SECRET          — your NEW secret (regenerate it!)
 *   RZP_WEBHOOK_SECRET      — from Razorpay Dashboard → Webhooks
 *   FIREBASE_PROJECT_ID     — printcrew-4436b
 *   FIREBASE_CLIENT_EMAIL   — from Firebase service account JSON
 *   FIREBASE_PRIVATE_KEY    — from Firebase service account JSON
 *   PORT                    — Railway sets this automatically
 */

'use strict';

const express   = require('express');
const crypto    = require('crypto');
const Razorpay  = require('razorpay');
const cors      = require('cors');
const admin     = require('firebase-admin');

// ── ENVIRONMENT ──────────────────────────────────────────────
const {
  RZP_KEY_ID          = '',
  RZP_KEY_SECRET      = '',
  RZP_WEBHOOK_SECRET  = '',
  FIREBASE_PROJECT_ID = 'printcrew-4436b',
  FIREBASE_CLIENT_EMAIL = '',
  FIREBASE_PRIVATE_KEY  = '',
  PORT                = 3000,
} = process.env;

if (!RZP_KEY_ID || !RZP_KEY_SECRET) {
  console.error('❌  RZP_KEY_ID and RZP_KEY_SECRET must be set.');
  process.exit(1);
}

// ── FIREBASE ADMIN ───────────────────────────────────────────
// Initialise only if credentials are present
let db = null;
if (FIREBASE_CLIENT_EMAIL && FIREBASE_PRIVATE_KEY) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   FIREBASE_PROJECT_ID,
        clientEmail: FIREBASE_CLIENT_EMAIL,
        privateKey:  FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });
    db = admin.firestore();
    console.log('✅  Firebase Admin connected →', FIREBASE_PROJECT_ID);
  } catch (e) {
    console.error('❌  Firebase Admin init failed:', e.message);
  }
} else {
  console.warn('⚠️   Firebase credentials not set — Firestore updates disabled.');
}

// ── RAZORPAY CLIENT ──────────────────────────────────────────
const razorpay = new Razorpay({
  key_id:     RZP_KEY_ID,
  key_secret: RZP_KEY_SECRET,
});

// ── EXPRESS ──────────────────────────────────────────────────
const app = express();

app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'] }));

// Raw body ONLY for webhook route (needed for signature check)
app.use('/api/webhook', express.raw({ type: 'application/json' }));

// JSON for everything else
app.use(express.json());

// ── HELPERS ──────────────────────────────────────────────────
async function updateOrderInFirestore(printcrewOrderId, updates) {
  if (!db) {
    console.warn('Firestore not available — cannot update order', printcrewOrderId);
    return false;
  }
  try {
    const ref = db.collection('orders').doc(printcrewOrderId);
    await ref.set({
      ...updates,
      _updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    console.log(`[FIRESTORE] Updated ${printcrewOrderId}:`, Object.keys(updates).join(', '));
    return true;
  } catch (e) {
    console.error('[FIRESTORE ERROR]', e.message);
    return false;
  }
}

async function appendStatusHistory(printcrewOrderId, status, extra = {}) {
  if (!db) return;
  try {
    const ref = db.collection('orders').doc(printcrewOrderId);
    await ref.update({
      status,
      statusHistory: admin.firestore.FieldValue.arrayUnion({
        status,
        time: new Date().toISOString(),
        ...extra,
      }),
      _updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch(e) {
    // Fallback to set if update fails (doc might not have statusHistory field)
    await updateOrderInFirestore(printcrewOrderId, { status });
  }
}

// ════════════════════════════════════════════════════════════
// GET /health
// ════════════════════════════════════════════════════════════
app.get('/health', (req, res) => {
  res.json({
    status:    'ok',
    service:   'PrintCrew Backend',
    firebase:  db ? 'connected' : 'not configured',
    timestamp: new Date().toISOString(),
  });
});

// ════════════════════════════════════════════════════════════
// POST /api/create-order
// Called by PrintCrew app → creates Razorpay Order → returns order_id
// The frontend passes order_id to Razorpay Checkout.
// Payments without a valid order_id are auto-refunded by Razorpay.
// ════════════════════════════════════════════════════════════
app.post('/api/create-order', async (req, res) => {
  try {
    const { amount, currency, receipt, notes } = req.body;

    if (!amount || typeof amount !== 'number' || amount < 100)
      return res.status(400).json({ error: 'Invalid amount (must be in paise, min 100)' });
    if (!receipt)
      return res.status(400).json({ error: 'receipt (PrintCrew Order ID) required' });

    const order = await razorpay.orders.create({
      amount:   Math.round(amount),
      currency: currency || 'INR',
      receipt:  String(receipt).slice(0, 40),
      notes: {
        printcrew_order_id: notes?.printcrew_order_id || receipt,
        machine:            notes?.machine            || '',
        pages:              String(notes?.pages       || ''),
      },
    });

    console.log(`[CREATE ORDER] rzp=${order.id} | pc=${receipt} | ₹${amount/100}`);
    res.json({ razorpay_order_id: order.id, amount: order.amount, currency: order.currency });

  } catch (e) {
    console.error('[CREATE ORDER ERROR]', e);
    res.status(500).json({ error: e.error?.description || e.message });
  }
});

// ════════════════════════════════════════════════════════════
// POST /api/verify-payment
// Called immediately after successful Razorpay payment.
// Verifies HMAC-SHA256 signature — this is the security check.
// A fake/tampered callback will fail this and be rejected.
// ════════════════════════════════════════════════════════════
app.post('/api/verify-payment', async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      printcrew_order_id,
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
      return res.status(400).json({ verified: false, error: 'Missing required fields' });

    const generated = crypto
      .createHmac('sha256', RZP_KEY_SECRET)
      .update(razorpay_order_id + '|' + razorpay_payment_id)
      .digest('hex');

    if (generated !== razorpay_signature) {
      console.warn(`[SIGNATURE MISMATCH] pc=${printcrew_order_id} | pay=${razorpay_payment_id}`);
      return res.status(400).json({ verified: false, error: 'Signature verification failed' });
    }

    console.log(`[VERIFIED] pc=${printcrew_order_id} | pay=${razorpay_payment_id}`);

    // Update Firestore order to "Payment Confirmed"
    await appendStatusHistory(printcrew_order_id, 'Payment Confirmed', {
      paymentId:  razorpay_payment_id,
      rzpOrderId: razorpay_order_id,
      verified:   true,
    });

    res.json({ verified: true, payment_id: razorpay_payment_id });

  } catch (e) {
    console.error('[VERIFY ERROR]', e);
    res.status(500).json({ verified: false, error: e.message });
  }
});

// ════════════════════════════════════════════════════════════
// POST /api/webhook
// Razorpay → sends events here asynchronously.
// This is the source of truth — always fires even if user closes browser.
//
// Setup in Razorpay Dashboard → Settings → Webhooks:
//   URL:    https://printcrew.railway.app/api/webhook
//   Secret: set in RZP_WEBHOOK_SECRET env var
//   Events: payment.captured, payment.failed, order.paid, refund.created
// ════════════════════════════════════════════════════════════
app.post('/api/webhook', async (req, res) => {
  // 1. Always respond 200 fast — Razorpay retries if no 200 within 5s
  res.json({ status: 'received' });

  // 2. Verify signature
  const signature = req.headers['x-razorpay-signature'];
  const body      = req.body;

  if (RZP_WEBHOOK_SECRET) {
    const generated = crypto
      .createHmac('sha256', RZP_WEBHOOK_SECRET)
      .update(body)
      .digest('hex');

    if (generated !== signature) {
      console.warn('[WEBHOOK] Invalid signature — ignoring event');
      return;
    }
  }

  // 3. Parse
  let event;
  try { event = JSON.parse(body.toString()); }
  catch(e) { console.error('[WEBHOOK] JSON parse failed'); return; }

  const type = event.event;
  console.log(`[WEBHOOK] ${type}`);

  // 4. Handle
  switch (type) {

    case 'payment.captured': {
      const pay = event.payload.payment.entity;
      const pcId = pay.notes?.printcrew_order_id || pay.order_id;
      console.log(`[CAPTURED] ₹${pay.amount/100} | pc=${pcId} | pay=${pay.id}`);
      if (pcId) await appendStatusHistory(pcId, 'Payment Confirmed', {
        paymentId: pay.id,
        method:    pay.method,
        bank:      pay.bank || '',
        verified:  true,
        source:    'webhook',
      });
      break;
    }

    case 'payment.failed': {
      const pay = event.payload.payment.entity;
      const pcId = pay.notes?.printcrew_order_id;
      const reason = pay.error_description || 'Unknown';
      console.log(`[FAILED] pc=${pcId} | reason=${reason}`);
      if (pcId) await updateOrderInFirestore(pcId, {
        status: 'Failed',
        failureReason: reason,
        failedAt: new Date().toISOString(),
      });
      break;
    }

    case 'order.paid': {
      const ord = event.payload.order.entity;
      console.log(`[ORDER PAID] receipt=${ord.receipt} | rzp=${ord.id}`);
      break;
    }

    case 'refund.created': {
      const ref = event.payload.refund.entity;
      console.log(`[REFUND] ₹${ref.amount/100} | refund=${ref.id} | pay=${ref.payment_id}`);
      // Find order by payment_id and update status
      if (db) {
        try {
          const snap = await db.collection('orders')
            .where('razorpayPaymentId', '==', ref.payment_id).limit(1).get();
          if (!snap.empty) {
            const pcId = snap.docs[0].id;
            await appendStatusHistory(pcId, 'Refund Issued', { refundId: ref.id });
          }
        } catch(e) { console.error('[REFUND LOOKUP]', e.message); }
      }
      break;
    }

    default:
      console.log(`[WEBHOOK] Unhandled: ${type}`);
  }
});

// ════════════════════════════════════════════════════════════
// GET /api/jobs/:machineId
// Polled by the Raspberry Pi every 5 seconds.
// Returns all "Payment Confirmed" orders for this machine.
// ════════════════════════════════════════════════════════════
app.get('/api/jobs/:machineId', async (req, res) => {
  if (!db) return res.json({ jobs: [] });
  try {
    const machineId = parseInt(req.params.machineId);
    const snap = await db.collection('orders')
      .where('machineId', '==', machineId)
      .where('status', '==', 'Payment Confirmed')
      .orderBy('timestamp', 'asc')
      .limit(10)
      .get();

    const jobs = snap.docs.map(d => {
      const o = d.data();
      return {
        orderId:     o.orderId,
        totalPages:  o.totalPages,
        items:       (o.items||[]).map(i => ({
          name:         i.name,
          copies:       i.copies,
          color:        i.color,
          orient:       i.orient,
          sides:        i.sides,
          uploadedFiles:(i.uploadedFiles||[]).filter(f=>f.downloadURL),
        })),
      };
    });

    res.json({ jobs });
  } catch (e) {
    console.error('[JOBS ERROR]', e);
    res.json({ jobs: [], error: e.message });
  }
});

// ════════════════════════════════════════════════════════════
// POST /api/jobs/:orderId/status
// Called by Raspberry Pi to update order status after printing.
// ════════════════════════════════════════════════════════════
app.post('/api/jobs/:orderId/status', async (req, res) => {
  const { orderId } = req.params;
  const { status, pages_printed, error } = req.body;

  const allowed = ['Queued', 'Printing', 'Completed', 'Failed'];
  if (!allowed.includes(status))
    return res.status(400).json({ error: 'Invalid status' });

  const updates = { status, pagesActuallyPrinted: pages_printed || 0 };
  if (error) updates.printError = error;

  await appendStatusHistory(orderId, status, { source: 'pi', pages_printed, error });
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════
// POST /api/refund
// Admin-initiated refund for a payment.
// ════════════════════════════════════════════════════════════
app.post('/api/refund', async (req, res) => {
  try {
    const { payment_id, amount, reason, printcrew_order_id } = req.body;
    if (!payment_id) return res.status(400).json({ error: 'payment_id required' });

    const refund = await razorpay.payments.refund(payment_id, {
      amount: amount ? Math.round(amount * 100) : undefined,
      speed:  'normal',
      notes:  { reason: reason || 'PrintCrew refund', printcrew_order_id },
    });

    if (printcrew_order_id) {
      await appendStatusHistory(printcrew_order_id, 'Refund Issued', {
        refundId: refund.id, amount: refund.amount / 100,
      });
    }

    res.json({ ok: true, refund_id: refund.id, amount: refund.amount / 100 });
  } catch (e) {
    console.error('[REFUND ERROR]', e);
    res.status(500).json({ error: e.error?.description || e.message });
  }
});

// ── 404 ──────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ── START ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  PrintCrew Backend on port ${PORT}`);
  console.log(`   Razorpay: ${RZP_KEY_ID}`);
  console.log(`   Firebase: ${db ? 'connected' : '⚠️  not configured'}`);
  console.log(`   Webhook:  ${RZP_WEBHOOK_SECRET ? 'secret set' : '⚠️  no secret'}\n`);
});

module.exports = app;
