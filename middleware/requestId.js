// X-Request-Id: accepted from the caller (e.g. an ERP gateway that already traces the call)
// or generated here, echoed on the response, included in JSON errors and passed on to
// outbound integration calls as X-Correlation-Id.
import crypto from "crypto";
import { requestContext } from "../utils/requestContext.js";

const SAFE_ID = /^[A-Za-z0-9._:-]{8,64}$/;

export const requestId = (req, res, next) => {
  const incoming = req.get("x-request-id");
  req.id = incoming && SAFE_ID.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader("X-Request-Id", req.id);
  requestContext.run({ requestId: req.id }, next);
};
