/**
 * The client-minted code for "the page dispatch budget never sent this request"
 * (design 08 §5 / design 26 §D7).
 *
 * ONE literal for the minting site (git-api), the deterministic-rejection test,
 * the coordinator's polling special-case and the code→copy table: a typo in any
 * of them would silently degrade the localized "page busy" copy into a raw
 * English message, which no type checker can catch.
 */
export const NOT_DISPATCHED_CODE = 'not-dispatched'
