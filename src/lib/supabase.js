import { createClient } from "@supabase/supabase-js";

/*
 * The address as it was on arrival, read before the client below starts and
 * tidies it away. A password-reset link lands on /reset with its outcome —
 * a sign-in, or why it failed — in the part after the #, which the client
 * consumes and clears as it starts up.
 */
export const arrival = { path: window.location.pathname, hash: window.location.hash };

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);
