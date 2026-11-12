"use strict";

const { cert, getApps, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { FieldValue, getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

let facade;

function serviceAccountCredential() {
  return cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  });
}

function getFirebaseAdmin() {
  if (facade) return facade;

  const app = getApps()[0] || initializeApp({ credential: serviceAccountCredential() });
  const firestore = () => getFirestore(app);
  firestore.FieldValue = FieldValue;

  // As rotas existentes usam uma interface pequena e fácil de injetar nos
  // testes. O adaptador mantém essa interface sem depender do namespace
  // legado removido no Firebase Admin 14.
  facade = Object.freeze({
    app,
    auth: () => getAuth(app),
    firestore,
    messaging: () => getMessaging(app),
  });
  return facade;
}

module.exports = { FieldValue, getFirebaseAdmin };
