// Re-render a form with the submitted values and the error message for
// validation/business-rule failures; anything else goes to the error handler.
import { UniqueConstraintError } from "sequelize";
import { duplicateMessage } from "./http.js";

const FORM_STATUSES = new Set([409, 422, 423, 503]);

export const formErrorMessage = (err) => {
  if (err instanceof UniqueConstraintError) return duplicateMessage(err);
  return FORM_STATUSES.has(err?.status) ? err.message : null;
};

export async function handleForm(res, action, { view, locals }) {
  try {
    return await action();
  } catch (err) {
    const message = formErrorMessage(err);
    if (!message) throw err;
    const data = typeof locals === "function" ? await locals() : locals;
    res.status(err.status || 409).render(view, { ...data, formError: message });
    return undefined;
  }
}
