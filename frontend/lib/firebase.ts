"use client";

import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import {
  GoogleAuthProvider,
  browserLocalPersistence,
  getAuth,
  type Auth,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as fbSignOut,
} from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  initializeFirestore,
  limit as fsLimit,
  memoryLocalCache,
  onSnapshot,
  orderBy as fsOrderBy,
  query as fsQuery,
  setDoc,
  updateDoc,
  where,
  type Firestore,
} from "firebase/firestore";

/**
 * Firebase web client bootstrap.
 * Config comes from NEXT_PUBLIC_FIREBASE_* build-time env vars.
 */
export const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? "",
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? "",
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "",
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ?? "",
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? "",
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID ?? "",
};

export const app: FirebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);

/**
 * Lazy singletons. initializeApp with a blank config is safe, but getAuth
 * throws auth/invalid-api-key when the key is missing — and this module is
 * imported by pages that Next prerenders at build time (e.g. /terms), where
 * env vars may not exist yet. Deferring getAuth/getFirestore to first use
 * keeps the build alive; the throw surfaces only if the app is actually used
 * without configuration.
 */
function lazySingleton<T extends object>(factory: () => T): T {
  let instance: T | undefined;
  return new Proxy({} as T, {
    // Firestore internals validate args with `instanceof` (e.g. collection()),
    // so the proxy must report the real instance's prototype once created.
    getPrototypeOf(_target) {
      instance ??= factory();
      return Object.getPrototypeOf(instance);
    },
    get(_target, prop) {
      instance ??= factory();
      const value = Reflect.get(instance, prop, instance);
      return typeof value === "function" ? value.bind(instance) : value;
    },
  });
}

export const auth: Auth = lazySingleton(() => {
  const a = getAuth(app);
  setPersistence(a, browserLocalPersistence).catch(() => {});
  return a;
});
// Transport: prefer streaming, but fall back to long polling when the
// network can't sustain it (proxies that kill WebChannel streams). Hard
// forcing long polling via experimentalForceLongPolling caused recurring
// "INTERNAL ASSERTION FAILED: Unexpected state" (ID: a54d) crashes in the
// SDK's grpc-web long-poll path (firebase-js-sdk#6907, #7731), which killed
// every Firestore listener on the page. Auto-detect keeps the streaming
// transport when possible while retaining the proxy workaround.
//
// The local cache is memory-only: the IndexedDB persistence layer is where
// the "INTERNAL ASSERTION FAILED: Unexpected state" (ID: s540/a54d)
// assertions live (corrupted cache schema, multi-tab races), and this app
// only touches Firestore as a backend-down fallback — there is no offline
// requirement worth trading away that reliability.
export const firestore: Firestore = lazySingleton(() =>
  initializeFirestore(app, {
    experimentalAutoDetectLongPolling: true,
    localCache: memoryLocalCache(),
  })
);

export { onAuthStateChanged };
