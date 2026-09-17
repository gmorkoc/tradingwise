


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE OR REPLACE FUNCTION "public"."adjust_comment_like_count"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if tg_op = 'INSERT' then
    update public.coin_comments set like_count = like_count + 1 where id = new.comment_id;
    return new;
  elsif tg_op = 'DELETE' then
    update public.coin_comments set like_count = greatest(0, like_count - 1) where id = old.comment_id;
    return old;
  end if;
  return null;
end;
$$;


ALTER FUNCTION "public"."adjust_comment_like_count"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
begin
  insert into public.profiles (id, full_name, email)
  values (
    new.id,
    new.raw_user_meta_data->>'full_name',
    new.email
  );
  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_username_available"("check_username" "text") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select not exists (
    select 1 from public.profiles where lower(username) = lower(check_username)
  );
$$;


ALTER FUNCTION "public"."is_username_available"("check_username" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."queue_comment_mentions"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  handle text;
begin
  for handle in
    select distinct m[1]
    from regexp_matches(new.body, '@([A-Za-z0-9_]{3,20})', 'g') as m
  loop
    insert into public.mention_notifications (comment_id, mentioned_user_id, mentioning_user_id, coin)
    select new.id, p.id, new.user_id, new.coin
    from public.profiles p
    where lower(p.username) = lower(handle)
      and p.id != new.user_id;
  end loop;

  return new;
end;
$$;


ALTER FUNCTION "public"."queue_comment_mentions"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_usernames"("prefix" "text", "limit_n" integer DEFAULT 6) RETURNS TABLE("username" "text")
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select p.username
  from public.profiles p
  where p.username is not null
    and p.username ilike prefix || '%'
  order by p.username
  limit greatest(1, least(limit_n, 20));
$$;


ALTER FUNCTION "public"."search_usernames"("prefix" "text", "limit_n" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."stamp_comment_author"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  select p.username, p.tier, p.avatar_url into new.username, new.tier, new.avatar_url
  from public.profiles p where p.id = new.user_id;

  if new.username is null then
    raise exception 'Set a username before posting';
  end if;
  if new.tier not in ('pro', 'elite') then
    raise exception 'Only Pro and Elite members can post comments';
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."stamp_comment_author"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."try_increment_ai_quota"("p_user_id" "uuid", "p_day_key" "text", "p_limit" integer) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_used    int;
  v_week    text;
  v_current int;
begin
  -- Lock this row so concurrent requests queue up instead of racing
  select ai_requests_used, ai_requests_week
  into   v_used, v_week
  from   public.profiles
  where  id = p_user_id
  for    update;

  if not found then return false; end if;

  v_current := case when v_week = p_day_key
                    then coalesce(v_used, 0)
                    else 0 end;

  if v_current >= p_limit then return false; end if;

  update public.profiles
  set    ai_requests_used = v_current + 1,
         ai_requests_week = p_day_key
  where  id = p_user_id;

  return true;
end;
$$;


ALTER FUNCTION "public"."try_increment_ai_quota"("p_user_id" "uuid", "p_day_key" "text", "p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_my_comment_avatars"("new_avatar_url" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  update public.coin_comments
  set avatar_url = new_avatar_url
  where user_id = auth.uid();
end;
$$;


ALTER FUNCTION "public"."update_my_comment_avatars"("new_avatar_url" "text") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."account_events" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "type" "text" NOT NULL,
    "detail" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."account_events" OWNER TO "postgres";


ALTER TABLE "public"."account_events" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."account_events_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."ai_usage_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "model" "text" NOT NULL,
    "input_tokens" integer DEFAULT 0 NOT NULL,
    "output_tokens" integer DEFAULT 0 NOT NULL,
    "cost_usd" numeric(10,6) DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."ai_usage_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."btc_price_alert_state" (
    "id" integer DEFAULT 1 NOT NULL,
    "anchor_price" double precision,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "btc_price_alert_state_single_row" CHECK (("id" = 1))
);


ALTER TABLE "public"."btc_price_alert_state" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."coin_comment_likes" (
    "id" bigint NOT NULL,
    "comment_id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."coin_comment_likes" OWNER TO "postgres";


ALTER TABLE "public"."coin_comment_likes" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."coin_comment_likes_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."coin_comments" (
    "id" bigint NOT NULL,
    "coin" "text" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "username" "text",
    "tier" "text",
    "body" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "like_count" integer DEFAULT 0 NOT NULL,
    "reply_to_id" bigint,
    "avatar_url" "text",
    CONSTRAINT "coin_comments_body_check" CHECK ((("char_length"(TRIM(BOTH FROM "body")) >= 1) AND ("char_length"(TRIM(BOTH FROM "body")) <= 500)))
);


ALTER TABLE "public"."coin_comments" OWNER TO "postgres";


ALTER TABLE "public"."coin_comments" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."coin_comments_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."comment_reports" (
    "id" bigint NOT NULL,
    "comment_id" bigint NOT NULL,
    "reporter_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."comment_reports" OWNER TO "postgres";


ALTER TABLE "public"."comment_reports" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."comment_reports_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."contact_submissions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "category" "text" NOT NULL,
    "email" "text" NOT NULL,
    "message" "text" NOT NULL,
    "user_id" "uuid"
);


ALTER TABLE "public"."contact_submissions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."daily_brief_alert_state" (
    "id" integer DEFAULT 1 NOT NULL,
    "last_seen_pubdate" bigint,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "daily_brief_alert_state_single_row" CHECK (("id" = 1))
);


ALTER TABLE "public"."daily_brief_alert_state" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."device_push_tokens" (
    "token" "text" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "platform" "text" DEFAULT 'ios'::"text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."device_push_tokens" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."mention_notifications" (
    "id" bigint NOT NULL,
    "comment_id" bigint NOT NULL,
    "mentioned_user_id" "uuid" NOT NULL,
    "mentioning_user_id" "uuid" NOT NULL,
    "coin" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "sent" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."mention_notifications" OWNER TO "postgres";


ALTER TABLE "public"."mention_notifications" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."mention_notifications_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."price_alerts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "coin" "text" NOT NULL,
    "target_price" double precision NOT NULL,
    "direction" "text" NOT NULL,
    "triggered" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "price_alerts_direction_check" CHECK (("direction" = ANY (ARRAY['above'::"text", 'below'::"text"])))
);


ALTER TABLE "public"."price_alerts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "full_name" "text",
    "email" "text",
    "tier" "text" DEFAULT 'free'::"text" NOT NULL,
    "stripe_customer_id" "text",
    "subscription_status" "text",
    "subscription_end_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ai_requests_used" integer DEFAULT 0 NOT NULL,
    "ai_requests_week" "date",
    "trader_level" "text",
    "terms_agreed_at" timestamp with time zone,
    "alert_sound" "text" DEFAULT 'bell'::"text" NOT NULL,
    "notify_daily_brief" boolean DEFAULT true NOT NULL,
    "notify_price_alerts" boolean DEFAULT true NOT NULL,
    "notify_upgrade_reminders" boolean DEFAULT true NOT NULL,
    "username" "text",
    "notify_mentions" boolean DEFAULT true NOT NULL,
    "avatar_url" "text",
    "notify_strategy_alerts" boolean DEFAULT true NOT NULL,
    "notify_breaking_news" boolean DEFAULT true NOT NULL,
    CONSTRAINT "username_format" CHECK ((("username" IS NULL) OR ("username" ~ '^[A-Za-z0-9_]{3,20}$'::"text")))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."strategy_alerts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "template_id" "text",
    "logic" "text" DEFAULT 'AND'::"text" NOT NULL,
    "conditions" "jsonb" NOT NULL,
    "coins" "text"[] NOT NULL,
    "cooldown_minutes" integer DEFAULT 60 NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "strategy_alerts_coins_check" CHECK (("array_length"("coins", 1) > 0)),
    CONSTRAINT "strategy_alerts_cooldown_minutes_check" CHECK (("cooldown_minutes" >= 1)),
    CONSTRAINT "strategy_alerts_logic_check" CHECK (("logic" = ANY (ARRAY['AND'::"text", 'OR'::"text"])))
);


ALTER TABLE "public"."strategy_alerts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."strategy_fires" (
    "id" bigint NOT NULL,
    "strategy_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "coin" "text" NOT NULL,
    "timeframe" "text" NOT NULL,
    "summary" "text" NOT NULL,
    "fired_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."strategy_fires" OWNER TO "postgres";


ALTER TABLE "public"."strategy_fires" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."strategy_fires_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."web_push_subscriptions" (
    "endpoint" "text" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "p256dh" "text" NOT NULL,
    "auth" "text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."web_push_subscriptions" OWNER TO "postgres";


ALTER TABLE ONLY "public"."account_events"
    ADD CONSTRAINT "account_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_usage_log"
    ADD CONSTRAINT "ai_usage_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."btc_price_alert_state"
    ADD CONSTRAINT "btc_price_alert_state_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."coin_comment_likes"
    ADD CONSTRAINT "coin_comment_likes_comment_id_user_id_key" UNIQUE ("comment_id", "user_id");



ALTER TABLE ONLY "public"."coin_comment_likes"
    ADD CONSTRAINT "coin_comment_likes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."coin_comments"
    ADD CONSTRAINT "coin_comments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."comment_reports"
    ADD CONSTRAINT "comment_reports_comment_id_reporter_id_key" UNIQUE ("comment_id", "reporter_id");



ALTER TABLE ONLY "public"."comment_reports"
    ADD CONSTRAINT "comment_reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contact_submissions"
    ADD CONSTRAINT "contact_submissions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."daily_brief_alert_state"
    ADD CONSTRAINT "daily_brief_alert_state_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."device_push_tokens"
    ADD CONSTRAINT "device_push_tokens_pkey" PRIMARY KEY ("token");



ALTER TABLE ONLY "public"."mention_notifications"
    ADD CONSTRAINT "mention_notifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."price_alerts"
    ADD CONSTRAINT "price_alerts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_stripe_customer_id_key" UNIQUE ("stripe_customer_id");



ALTER TABLE ONLY "public"."strategy_alerts"
    ADD CONSTRAINT "strategy_alerts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."strategy_fires"
    ADD CONSTRAINT "strategy_fires_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."web_push_subscriptions"
    ADD CONSTRAINT "web_push_subscriptions_pkey" PRIMARY KEY ("endpoint");



CREATE INDEX "account_events_user_id_created_at_idx" ON "public"."account_events" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "ai_usage_log_created_at_idx" ON "public"."ai_usage_log" USING "btree" ("created_at");



CREATE INDEX "ai_usage_log_user_id_idx" ON "public"."ai_usage_log" USING "btree" ("user_id");



CREATE INDEX "coin_comment_likes_comment_idx" ON "public"."coin_comment_likes" USING "btree" ("comment_id");



CREATE INDEX "coin_comment_likes_user_idx" ON "public"."coin_comment_likes" USING "btree" ("user_id");



CREATE INDEX "coin_comments_coin_created_idx" ON "public"."coin_comments" USING "btree" ("coin", "created_at" DESC);



CREATE INDEX "coin_comments_reply_to_idx" ON "public"."coin_comments" USING "btree" ("reply_to_id") WHERE ("reply_to_id" IS NOT NULL);



CREATE INDEX "device_push_tokens_user_id_idx" ON "public"."device_push_tokens" USING "btree" ("user_id");



CREATE INDEX "mention_notifications_pending_idx" ON "public"."mention_notifications" USING "btree" ("comment_id") WHERE ("sent" = false);



CREATE INDEX "price_alerts_pending_idx" ON "public"."price_alerts" USING "btree" ("coin") WHERE (NOT "triggered");



CREATE INDEX "profiles_stripe_customer_id_idx" ON "public"."profiles" USING "btree" ("stripe_customer_id");



CREATE UNIQUE INDEX "profiles_username_lower_idx" ON "public"."profiles" USING "btree" ("lower"("username")) WHERE ("username" IS NOT NULL);



CREATE INDEX "strategy_alerts_enabled_idx" ON "public"."strategy_alerts" USING "btree" ("id") WHERE "enabled";



CREATE INDEX "strategy_fires_cooldown_idx" ON "public"."strategy_fires" USING "btree" ("strategy_id", "coin", "fired_at" DESC);



CREATE INDEX "strategy_fires_user_recent_idx" ON "public"."strategy_fires" USING "btree" ("user_id", "fired_at" DESC);



CREATE INDEX "web_push_subscriptions_user_id_idx" ON "public"."web_push_subscriptions" USING "btree" ("user_id");



CREATE OR REPLACE TRIGGER "adjust_comment_like_count_trigger" AFTER INSERT OR DELETE ON "public"."coin_comment_likes" FOR EACH ROW EXECUTE FUNCTION "public"."adjust_comment_like_count"();



CREATE OR REPLACE TRIGGER "queue_comment_mentions_trigger" AFTER INSERT ON "public"."coin_comments" FOR EACH ROW EXECUTE FUNCTION "public"."queue_comment_mentions"();



CREATE OR REPLACE TRIGGER "stamp_comment_author_trigger" BEFORE INSERT ON "public"."coin_comments" FOR EACH ROW EXECUTE FUNCTION "public"."stamp_comment_author"();



ALTER TABLE ONLY "public"."account_events"
    ADD CONSTRAINT "account_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_usage_log"
    ADD CONSTRAINT "ai_usage_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."coin_comment_likes"
    ADD CONSTRAINT "coin_comment_likes_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "public"."coin_comments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."coin_comment_likes"
    ADD CONSTRAINT "coin_comment_likes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."coin_comments"
    ADD CONSTRAINT "coin_comments_reply_to_id_fkey" FOREIGN KEY ("reply_to_id") REFERENCES "public"."coin_comments"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."coin_comments"
    ADD CONSTRAINT "coin_comments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."comment_reports"
    ADD CONSTRAINT "comment_reports_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "public"."coin_comments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."comment_reports"
    ADD CONSTRAINT "comment_reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contact_submissions"
    ADD CONSTRAINT "contact_submissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."device_push_tokens"
    ADD CONSTRAINT "device_push_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."mention_notifications"
    ADD CONSTRAINT "mention_notifications_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "public"."coin_comments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."mention_notifications"
    ADD CONSTRAINT "mention_notifications_mentioned_user_id_fkey" FOREIGN KEY ("mentioned_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."mention_notifications"
    ADD CONSTRAINT "mention_notifications_mentioning_user_id_fkey" FOREIGN KEY ("mentioning_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."price_alerts"
    ADD CONSTRAINT "price_alerts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."strategy_alerts"
    ADD CONSTRAINT "strategy_alerts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."strategy_fires"
    ADD CONSTRAINT "strategy_fires_strategy_id_fkey" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategy_alerts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."strategy_fires"
    ADD CONSTRAINT "strategy_fires_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."web_push_subscriptions"
    ADD CONSTRAINT "web_push_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



CREATE POLICY "Users can create their own profile" ON "public"."profiles" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "id"));



CREATE POLICY "Users can update own profile" ON "public"."profiles" FOR UPDATE USING (("auth"."uid"() = "id"));



CREATE POLICY "Users can view own profile" ON "public"."profiles" FOR SELECT USING (("auth"."uid"() = "id"));



CREATE POLICY "Users can view their own account events" ON "public"."account_events" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users manage their own price alerts" ON "public"."price_alerts" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users manage their own push tokens" ON "public"."device_push_tokens" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users manage their own strategy alerts" ON "public"."strategy_alerts" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users manage their own web push subscriptions" ON "public"."web_push_subscriptions" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users view their own strategy fires" ON "public"."strategy_fires" FOR SELECT USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."account_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_usage_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "anyone can insert" ON "public"."contact_submissions" FOR INSERT WITH CHECK (true);



CREATE POLICY "authenticated users can like a comment" ON "public"."coin_comment_likes" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "authenticated users can read coin comments" ON "public"."coin_comments" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated users can report a comment" ON "public"."comment_reports" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "reporter_id"));



ALTER TABLE "public"."btc_price_alert_state" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."coin_comment_likes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."coin_comments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."comment_reports" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."contact_submissions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."daily_brief_alert_state" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."device_push_tokens" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."mention_notifications" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."price_alerts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pro and elite members can post coin comments" ON "public"."coin_comments" FOR INSERT TO "authenticated" WITH CHECK ((("auth"."uid"() = "user_id") AND (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."tier" = ANY (ARRAY['pro'::"text", 'elite'::"text"])))))));



ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."strategy_alerts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."strategy_fires" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "users can delete their own coin comments" ON "public"."coin_comments" FOR DELETE TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "users can remove their own like" ON "public"."coin_comment_likes" FOR DELETE TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "users can see their own likes" ON "public"."coin_comment_likes" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "users can see their own mentions" ON "public"."mention_notifications" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "mentioned_user_id"));



ALTER TABLE "public"."web_push_subscriptions" ENABLE ROW LEVEL SECURITY;


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON FUNCTION "public"."adjust_comment_like_count"() TO "anon";
GRANT ALL ON FUNCTION "public"."adjust_comment_like_count"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."adjust_comment_like_count"() TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."is_username_available"("check_username" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."is_username_available"("check_username" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_username_available"("check_username" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."queue_comment_mentions"() TO "anon";
GRANT ALL ON FUNCTION "public"."queue_comment_mentions"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."queue_comment_mentions"() TO "service_role";



GRANT ALL ON FUNCTION "public"."search_usernames"("prefix" "text", "limit_n" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."search_usernames"("prefix" "text", "limit_n" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_usernames"("prefix" "text", "limit_n" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."stamp_comment_author"() TO "anon";
GRANT ALL ON FUNCTION "public"."stamp_comment_author"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."stamp_comment_author"() TO "service_role";



GRANT ALL ON FUNCTION "public"."try_increment_ai_quota"("p_user_id" "uuid", "p_day_key" "text", "p_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."try_increment_ai_quota"("p_user_id" "uuid", "p_day_key" "text", "p_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."try_increment_ai_quota"("p_user_id" "uuid", "p_day_key" "text", "p_limit" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."update_my_comment_avatars"("new_avatar_url" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."update_my_comment_avatars"("new_avatar_url" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_my_comment_avatars"("new_avatar_url" "text") TO "service_role";



GRANT ALL ON TABLE "public"."account_events" TO "anon";
GRANT ALL ON TABLE "public"."account_events" TO "authenticated";
GRANT ALL ON TABLE "public"."account_events" TO "service_role";



GRANT ALL ON SEQUENCE "public"."account_events_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."account_events_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."account_events_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."ai_usage_log" TO "anon";
GRANT ALL ON TABLE "public"."ai_usage_log" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_usage_log" TO "service_role";



GRANT ALL ON TABLE "public"."btc_price_alert_state" TO "anon";
GRANT ALL ON TABLE "public"."btc_price_alert_state" TO "authenticated";
GRANT ALL ON TABLE "public"."btc_price_alert_state" TO "service_role";



GRANT ALL ON TABLE "public"."coin_comment_likes" TO "anon";
GRANT ALL ON TABLE "public"."coin_comment_likes" TO "authenticated";
GRANT ALL ON TABLE "public"."coin_comment_likes" TO "service_role";



GRANT ALL ON SEQUENCE "public"."coin_comment_likes_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."coin_comment_likes_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."coin_comment_likes_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."coin_comments" TO "anon";
GRANT ALL ON TABLE "public"."coin_comments" TO "authenticated";
GRANT ALL ON TABLE "public"."coin_comments" TO "service_role";



GRANT ALL ON SEQUENCE "public"."coin_comments_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."coin_comments_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."coin_comments_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."comment_reports" TO "anon";
GRANT ALL ON TABLE "public"."comment_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."comment_reports" TO "service_role";



GRANT ALL ON SEQUENCE "public"."comment_reports_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."comment_reports_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."comment_reports_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."contact_submissions" TO "anon";
GRANT ALL ON TABLE "public"."contact_submissions" TO "authenticated";
GRANT ALL ON TABLE "public"."contact_submissions" TO "service_role";



GRANT ALL ON TABLE "public"."daily_brief_alert_state" TO "anon";
GRANT ALL ON TABLE "public"."daily_brief_alert_state" TO "authenticated";
GRANT ALL ON TABLE "public"."daily_brief_alert_state" TO "service_role";



GRANT ALL ON TABLE "public"."device_push_tokens" TO "anon";
GRANT ALL ON TABLE "public"."device_push_tokens" TO "authenticated";
GRANT ALL ON TABLE "public"."device_push_tokens" TO "service_role";



GRANT ALL ON TABLE "public"."mention_notifications" TO "anon";
GRANT ALL ON TABLE "public"."mention_notifications" TO "authenticated";
GRANT ALL ON TABLE "public"."mention_notifications" TO "service_role";



GRANT ALL ON SEQUENCE "public"."mention_notifications_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."mention_notifications_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."mention_notifications_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."price_alerts" TO "anon";
GRANT ALL ON TABLE "public"."price_alerts" TO "authenticated";
GRANT ALL ON TABLE "public"."price_alerts" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT UPDATE("ai_requests_used") ON TABLE "public"."profiles" TO "authenticated";



GRANT UPDATE("ai_requests_week") ON TABLE "public"."profiles" TO "authenticated";



GRANT UPDATE("trader_level") ON TABLE "public"."profiles" TO "authenticated";



GRANT UPDATE("terms_agreed_at") ON TABLE "public"."profiles" TO "authenticated";



GRANT UPDATE("alert_sound") ON TABLE "public"."profiles" TO "authenticated";



GRANT UPDATE("notify_daily_brief") ON TABLE "public"."profiles" TO "authenticated";



GRANT UPDATE("notify_price_alerts") ON TABLE "public"."profiles" TO "authenticated";



GRANT UPDATE("notify_upgrade_reminders") ON TABLE "public"."profiles" TO "authenticated";



GRANT UPDATE("username") ON TABLE "public"."profiles" TO "authenticated";



GRANT UPDATE("notify_mentions") ON TABLE "public"."profiles" TO "authenticated";



GRANT UPDATE("avatar_url") ON TABLE "public"."profiles" TO "authenticated";



GRANT UPDATE("notify_breaking_news") ON TABLE "public"."profiles" TO "authenticated";



GRANT ALL ON TABLE "public"."strategy_alerts" TO "anon";
GRANT ALL ON TABLE "public"."strategy_alerts" TO "authenticated";
GRANT ALL ON TABLE "public"."strategy_alerts" TO "service_role";



GRANT ALL ON TABLE "public"."strategy_fires" TO "anon";
GRANT ALL ON TABLE "public"."strategy_fires" TO "authenticated";
GRANT ALL ON TABLE "public"."strategy_fires" TO "service_role";



GRANT ALL ON SEQUENCE "public"."strategy_fires_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."strategy_fires_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."strategy_fires_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."web_push_subscriptions" TO "anon";
GRANT ALL ON TABLE "public"."web_push_subscriptions" TO "authenticated";
GRANT ALL ON TABLE "public"."web_push_subscriptions" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";

-- This dump was taken with `supabase db dump --schema public`, which
-- captures public.handle_new_user() itself but not the trigger that fires
-- it — that trigger is metadata attached to auth.users, outside the
-- public-schema dump scope, even though the function it calls lives in
-- public. It genuinely exists on the live project (new signups do get a
-- profiles row there); this just restates it so a from-scratch local
-- replay behaves the same way.
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();







