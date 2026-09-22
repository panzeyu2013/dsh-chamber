/**
 * Browser-side SemVer comparator for the /chamber dashboard:
 * ONE local source of the precedence rules, interpolated verbatim into the
 * dashboard script by routes.ts. It deliberately does NOT import the shared
 * dsh-runtime comparator — the dashboard script is a classic inline script, so
 * the rules must ship as source text (regex-free: a backslash escape inside the
 * template literal would be consumed). A lockstep test
 * (test/boundary/dashboard-semver-lockstep.test.ts) evaluates exactly these
 * bytes and pins the shared conclusion for valid semver, plus the documented
 * invalid-input policy difference (this comparator compares unparseable
 * versions equal so a stable sort keeps them at the tail; the shared
 * dsh-runtime comparator sorts invalid versions last).
 */
export const DASHBOARD_SEMVER_JS = `
  function semverNumericCompare(a, b) {
    if (a.length !== b.length) return a.length < b.length ? -1 : 1;
    return a === b ? 0 : (a < b ? -1 : 1);
  }
  function semverIsDigits(s) {
    if (s.length === 0) return false;
    for (var i = 0; i < s.length; i += 1) {
      var c = s.charCodeAt(i);
      if (c < 48 || c > 57) return false;
    }
    return true;
  }
  function semverParse(value) {
    var plus = value.indexOf('+');
    if (plus !== -1) value = value.slice(0, plus);
    var dash = value.indexOf('-');
    var core = (dash === -1 ? value : value.slice(0, dash)).split('.');
    if (core.length !== 3) return null;
    var nums = [];
    for (var i = 0; i < 3; i += 1) {
      var part = core[i];
      if (!semverIsDigits(part)) return null;
      if (part.length > 1 && part.charCodeAt(0) === 48) return null;
      nums.push(part);
    }
    return { core: nums, prerelease: dash === -1 ? [] : value.slice(dash + 1).split('.') };
  }
  function semverCompare(a, b) {
    var left = semverParse(a), right = semverParse(b);
    if (left === null || right === null) return 0;
    for (var i = 0; i < 3; i += 1) {
      var c = semverNumericCompare(left.core[i], right.core[i]);
      if (c !== 0) return c;
    }
    var lp = left.prerelease, rp = right.prerelease;
    if (lp.length === 0 || rp.length === 0) {
      if (lp.length === rp.length) return 0;
      return lp.length === 0 ? 1 : -1;
    }
    var common = Math.min(lp.length, rp.length);
    for (var j = 0; j < common; j += 1) {
      var x = lp[j], y = rp[j];
      if (x === y) continue;
      var xn = semverIsDigits(x), yn = semverIsDigits(y);
      if (xn && yn) return semverNumericCompare(x, y);
      if (xn !== yn) return xn ? -1 : 1;
      return x < y ? -1 : 1;
    }
    if (lp.length === rp.length) return 0;
    return lp.length < rp.length ? -1 : 1;
  }
`;
