// firebase.js (ES module)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBwZwhTVPYhtPuNyFRA-_v5H2FfF8_1uAU",
  authDomain: "board-review-c9f44.firebaseapp.com",
  projectId: "board-review-c9f44",
  storageBucket: "board-review-c9f44.firebasestorage.app",
  messagingSenderId: "1010525558634",
  appId: "1:1010525558634:web:bed3ce6e717a169036b713",
  measurementId: "G-7CSHL5ES9K"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
