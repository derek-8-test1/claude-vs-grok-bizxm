-- a2ea1529 item 5 -- THE WORKER PROXY HALF. W1, Day 227.
-- Cloud (e4273eac): "closing it needs one more half: when the Worker route exists it calls
-- capture_lead with the service role and the CF-Connecting-IP hash, and in the SAME change anon
-- EXECUTE on capture_lead is REVOKED. Otherwise anyone holding the public anon key can call the
-- RPC directly with a made-up hash and bypass the cap." Silver flagged the same requirement
-- (282c34fd) and this migration is that "same change" -- it must land in the SAME deploy as
-- POST /leads in src/index.ts, never before or after it, or the public endpoint goes dark for
-- a window with no replacement (revoke first) or the bypass stays open for a window (route
-- first, revoke never).
--
-- service_role keeps EXECUTE (it already had it, via the SECURITY DEFINER owner grant path --
-- explicit here so a reader does not have to go and check).
revoke execute on function public.capture_lead(uuid, text, text, text, text, text, text)
  from anon, authenticated;
grant execute on function public.capture_lead(uuid, text, text, text, text, text, text)
  to service_role;
