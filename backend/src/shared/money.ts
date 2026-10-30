import { invalid } from "../http/errors.js";

/** The API speaks rupees; everything stored or computed is integer paise. */
export function rupeesToPaise(rupees: number) {
  const paise = Math.round(rupees * 100);
  if (!Number.isSafeInteger(paise) || paise <= 0 || Math.abs(rupees * 100 - paise) > 1e-6)
    throw invalid("Enter an amount above zero with at most two decimal places.");
  return paise;
}

export const paiseToRupees = (paise: number) => paise / 100;
