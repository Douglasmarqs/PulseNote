// Firebase Auth and Firestore do not share a transaction. Keep a server-read
// copy of the document until the Auth deletion succeeds, so a failed Auth
// request does not leave a live account without its PulseNote data.
export async function deleteAccountDataAndIdentity({ readData, deleteData, deleteIdentity, restoreData }) {
  const backup = await readData();
  if (!backup) {
    const error = new Error("Não foi possível confirmar os dados da conta na nuvem.");
    error.code = "data/snapshot-failed";
    throw error;
  }

  let dataDeleted = false;
  try {
    await deleteData();
    dataDeleted = true;
    await deleteIdentity();
  } catch (error) {
    if (dataDeleted) {
      try {
        await restoreData(backup);
      } catch (restoreError) {
        const recoveryError = new Error("A exclusão falhou e os dados não puderam ser restaurados na nuvem.", { cause: restoreError });
        recoveryError.code = "data/restore-failed";
        recoveryError.originalError = error;
        throw recoveryError;
      }
    }
    throw error;
  }
}
