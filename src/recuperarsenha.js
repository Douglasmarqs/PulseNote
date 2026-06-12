import {
 sendPasswordResetEmail
} from "firebase/auth";

import { auth } from "./firebase/auth";

async function recuperarSenha(){

 const email =
 document.getElementById("email").value;

 await sendPasswordResetEmail(
   auth,
   email
 );

 alert(
   "Link enviado para seu e-mail"
 );

}