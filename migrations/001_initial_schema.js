'use strict';

// Consolidated baseline schema — replaces individual migrations 001–020.
// Generated from pg_dump of forescore_dev after all migrations were applied.

exports.up = async (knex) => {
  await knex.raw(`
    CREATE TABLE public.ambrose_drives (
        id integer NOT NULL,
        scorecard_id integer NOT NULL,
        hole_number integer NOT NULL,
        drive_taken_user_id integer NOT NULL,
        created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE SEQUENCE public.ambrose_drives_id_seq
        AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
    ALTER SEQUENCE public.ambrose_drives_id_seq OWNED BY public.ambrose_drives.id;

    CREATE TABLE public.ambrose_groups (
        id integer NOT NULL,
        tour_id integer CONSTRAINT ambrose_groups_event_id_not_null NOT NULL,
        round_number integer CONSTRAINT ambrose_groups_day_not_null NOT NULL,
        group_number integer NOT NULL,
        tee_time time without time zone NOT NULL,
        tee_location character varying(255) NOT NULL,
        starting_hole integer DEFAULT 1 NOT NULL,
        created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE SEQUENCE public.ambrose_groups_id_seq
        AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
    ALTER SEQUENCE public.ambrose_groups_id_seq OWNED BY public.ambrose_groups.id;

    CREATE TABLE public.calcutta_auctions (
        id integer NOT NULL,
        tour_id integer CONSTRAINT calcutta_auctions_event_id_not_null NOT NULL,
        auctioned_user_id integer NOT NULL,
        buyer_user_id integer NOT NULL,
        owner_user_id integer,
        auction_bid_amount numeric(10,2) DEFAULT '0'::numeric NOT NULL,
        draw_order integer NOT NULL,
        created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE SEQUENCE public.calcutta_auctions_id_seq
        AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
    ALTER SEQUENCE public.calcutta_auctions_id_seq OWNED BY public.calcutta_auctions.id;

    CREATE TABLE public.courses (
        id integer NOT NULL,
        tenant_id integer NOT NULL,
        course_name character varying(255) NOT NULL,
        tee_name character varying(255) NOT NULL,
        api_course_id integer,
        api_tee_key character varying(255),
        created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
        gender character varying(10) DEFAULT 'mens'::character varying NOT NULL,
        course_rating numeric(4,1),
        slope_rating integer
    );
    CREATE SEQUENCE public.courses_id_seq
        AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
    ALTER SEQUENCE public.courses_id_seq OWNED BY public.courses.id;

    CREATE TABLE public.golf_rounds (
        id integer CONSTRAINT event_day_statuses_id_not_null NOT NULL,
        tour_id integer CONSTRAINT event_day_statuses_event_id_not_null NOT NULL,
        round_number integer CONSTRAINT event_day_statuses_day_not_null NOT NULL,
        status character varying(255) DEFAULT 'draft'::character varying CONSTRAINT event_day_statuses_status_not_null NOT NULL,
        calc_type character varying(255) DEFAULT 'stableford'::character varying CONSTRAINT event_day_statuses_calc_type_not_null NOT NULL,
        leaderboard_published boolean DEFAULT false CONSTRAINT event_day_statuses_leaderboard_published_not_null NOT NULL,
        course_id integer CONSTRAINT event_day_statuses_course_id_not_null NOT NULL,
        created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP CONSTRAINT event_day_statuses_created_at_not_null NOT NULL,
        updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP CONSTRAINT event_day_statuses_updated_at_not_null NOT NULL,
        ambrose_prizes jsonb DEFAULT '[]'::jsonb CONSTRAINT event_day_statuses_ambrose_prizes_not_null NOT NULL,
        two_ball_enabled boolean DEFAULT false CONSTRAINT event_day_statuses_two_ball_enabled_not_null NOT NULL,
        two_ball_type character varying(20),
        tour_date date NOT NULL,
        female_course_id integer,
        virtual_teams_enabled boolean DEFAULT false NOT NULL
    );
    CREATE SEQUENCE public.event_day_statuses_id_seq
        AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
    ALTER SEQUENCE public.event_day_statuses_id_seq OWNED BY public.golf_rounds.id;

    CREATE TABLE public.event_players (
        id integer NOT NULL,
        tour_id integer CONSTRAINT event_players_event_id_not_null NOT NULL,
        user_id integer NOT NULL,
        status character varying(255) DEFAULT 'active'::character varying NOT NULL,
        created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE SEQUENCE public.event_players_id_seq
        AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
    ALTER SEQUENCE public.event_players_id_seq OWNED BY public.event_players.id;

    CREATE TABLE public.tours (
        id integer CONSTRAINT events_id_not_null NOT NULL,
        tenant_id integer CONSTRAINT events_tenant_id_not_null NOT NULL,
        label character varying(255) CONSTRAINT events_label_not_null NOT NULL,
        year integer CONSTRAINT events_year_not_null NOT NULL,
        location character varying(255) CONSTRAINT events_location_not_null NOT NULL,
        leaderboard_dirty_at timestamp with time zone,
        prize_ntp_amount numeric(10,2) DEFAULT '0'::numeric CONSTRAINT events_prize_ntp_amount_not_null NOT NULL,
        prize_long_drive_amount numeric(10,2) DEFAULT '0'::numeric CONSTRAINT events_prize_long_drive_amount_not_null NOT NULL,
        skins_amount_per_player_per_hole numeric(10,2) DEFAULT '1'::numeric CONSTRAINT events_skins_amount_per_player_per_hole_not_null NOT NULL,
        calcutta_owner_daily_winner_percent numeric(5,2) DEFAULT '5'::numeric CONSTRAINT events_calcutta_owner_daily_winner_percent_not_null NOT NULL,
        calcutta_champion_percent numeric(5,2) DEFAULT '10'::numeric CONSTRAINT events_calcutta_champion_percent_not_null NOT NULL,
        calcutta_champion_owner_percent numeric(5,2) DEFAULT '70'::numeric CONSTRAINT events_calcutta_champion_owner_percent_not_null NOT NULL,
        calcutta_mystery_place_percent numeric(5,2) DEFAULT '5'::numeric CONSTRAINT events_calcutta_mystery_place_percent_not_null NOT NULL,
        calcutta_mystery_place integer,
        created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP CONSTRAINT events_created_at_not_null NOT NULL,
        updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP CONSTRAINT events_updated_at_not_null NOT NULL,
        status character varying(20) DEFAULT 'draft'::character varying CONSTRAINT events_status_not_null NOT NULL,
        is_paid boolean DEFAULT false CONSTRAINT events_is_paid_not_null NOT NULL,
        paid_at timestamp with time zone,
        skins_enabled boolean DEFAULT false CONSTRAINT events_skins_enabled_not_null NOT NULL,
        leaderboard_best_of_rounds integer,
        leaderboard_last_round_required boolean DEFAULT false CONSTRAINT events_leaderboard_last_round_required_not_null NOT NULL,
        calcutta_enabled boolean DEFAULT false CONSTRAINT events_calcutta_enabled_not_null NOT NULL,
        tour_prizes jsonb DEFAULT '[]'::jsonb CONSTRAINT events_tour_prizes_not_null NOT NULL,
        daily_prizes jsonb DEFAULT '[]'::jsonb CONSTRAINT events_daily_prizes_not_null NOT NULL,
        gender character varying(10) DEFAULT 'mens'::character varying NOT NULL,
        skins_carry_in_skins integer,
        CONSTRAINT tours_status_check CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'active'::character varying, 'completed'::character varying])::text[])))
    );
    COMMENT ON COLUMN public.tours.skins_carry_in_skins IS 'Number of skins carried in from a prior tour/year into Round 1 Hole 1';
    CREATE SEQUENCE public.events_id_seq
        AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
    ALTER SEQUENCE public.events_id_seq OWNED BY public.tours.id;

    CREATE TABLE public.holes (
        id integer NOT NULL,
        course_id integer NOT NULL,
        hole_number integer NOT NULL,
        par integer NOT NULL,
        length_meters integer,
        stroke_index_primary integer NOT NULL,
        stroke_index_secondary integer NOT NULL,
        created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE SEQUENCE public.holes_id_seq
        AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
    ALTER SEQUENCE public.holes_id_seq OWNED BY public.holes.id;

    CREATE TABLE public.invitations (
        id integer NOT NULL,
        tenant_id integer NOT NULL,
        email character varying(255) NOT NULL,
        role character varying(255) DEFAULT 'player'::character varying NOT NULL,
        token_hash character varying(255) NOT NULL,
        expires_at timestamp with time zone NOT NULL,
        accepted_at timestamp with time zone,
        invited_by_user_id integer,
        created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE SEQUENCE public.invitations_id_seq
        AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
    ALTER SEQUENCE public.invitations_id_seq OWNED BY public.invitations.id;

    CREATE TABLE public.itinerary_items (
        id integer NOT NULL,
        tour_id integer NOT NULL,
        item_date date NOT NULL,
        type character varying(50) NOT NULL,
        start_time time without time zone,
        end_time time without time zone,
        title character varying(255) NOT NULL,
        description text,
        location character varying(255),
        details jsonb,
        sort_order integer DEFAULT 0 NOT NULL,
        created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
        end_date date,
        user_id integer
    );
    CREATE SEQUENCE public.itinerary_items_id_seq
        AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
    ALTER SEQUENCE public.itinerary_items_id_seq OWNED BY public.itinerary_items.id;

    CREATE TABLE public.leaderboard_snapshots (
        id integer NOT NULL,
        tour_id integer CONSTRAINT leaderboard_snapshots_event_id_not_null NOT NULL,
        round_number integer CONSTRAINT leaderboard_snapshots_day_not_null NOT NULL,
        competition_type character varying(255) NOT NULL,
        payload jsonb NOT NULL,
        calculated_at timestamp with time zone NOT NULL,
        created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE SEQUENCE public.leaderboard_snapshots_id_seq
        AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
    ALTER SEQUENCE public.leaderboard_snapshots_id_seq OWNED BY public.leaderboard_snapshots.id;

    CREATE TABLE public.login_codes (
        id integer NOT NULL,
        user_id integer NOT NULL,
        code_hash character varying(255) NOT NULL,
        expires_at timestamp with time zone NOT NULL,
        used_at timestamp with time zone,
        ip character varying(255),
        user_agent character varying(255),
        created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE SEQUENCE public.login_codes_id_seq
        AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
    ALTER SEQUENCE public.login_codes_id_seq OWNED BY public.login_codes.id;

    CREATE TABLE public.novelty_events (
        id integer NOT NULL,
        tour_id integer CONSTRAINT novelty_events_event_id_not_null NOT NULL,
        round_number integer CONSTRAINT novelty_events_day_not_null NOT NULL,
        course_id integer NOT NULL,
        hole_number integer NOT NULL,
        novelty_type character varying(32) NOT NULL,
        label character varying(120) NOT NULL,
        created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE SEQUENCE public.novelty_events_id_seq
        AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
    ALTER SEQUENCE public.novelty_events_id_seq OWNED BY public.novelty_events.id;

    CREATE TABLE public.novelty_results (
        id integer NOT NULL,
        tour_id integer CONSTRAINT novelty_results_event_id_not_null NOT NULL,
        round_number integer CONSTRAINT novelty_results_day_not_null NOT NULL,
        novelty_event_id integer NOT NULL,
        winner_user_id integer,
        winner_team_id integer,
        is_no_winner boolean DEFAULT false NOT NULL,
        created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE SEQUENCE public.novelty_results_id_seq
        AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
    ALTER SEQUENCE public.novelty_results_id_seq OWNED BY public.novelty_results.id;

    CREATE TABLE public.player_day_handicaps (
        id integer NOT NULL,
        tour_id integer CONSTRAINT player_day_handicaps_event_id_not_null NOT NULL,
        user_id integer NOT NULL,
        round_number integer CONSTRAINT player_day_handicaps_day_not_null NOT NULL,
        handicap_index numeric(5,1) NOT NULL,
        created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE SEQUENCE public.player_day_handicaps_id_seq
        AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
    ALTER SEQUENCE public.player_day_handicaps_id_seq OWNED BY public.player_day_handicaps.id;

    CREATE TABLE public.player_handicaps (
        id integer NOT NULL,
        tour_id integer CONSTRAINT player_handicaps_event_id_not_null NOT NULL,
        user_id integer NOT NULL,
        playing_handicap numeric(5,2) NOT NULL,
        created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE SEQUENCE public.player_handicaps_id_seq
        AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
    ALTER SEQUENCE public.player_handicaps_id_seq OWNED BY public.player_handicaps.id;

    CREATE TABLE public.scorecard_edit_logs (
        id integer NOT NULL,
        scorecard_id integer NOT NULL,
        hole_number integer NOT NULL,
        previous_gross_score integer,
        previous_stableford_points integer,
        new_gross_score integer,
        new_stableford_points integer,
        editor_user_id integer,
        created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE SEQUENCE public.scorecard_edit_logs_id_seq
        AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
    ALTER SEQUENCE public.scorecard_edit_logs_id_seq OWNED BY public.scorecard_edit_logs.id;

    CREATE TABLE public.scorecard_holes (
        id integer NOT NULL,
        scorecard_id integer NOT NULL,
        hole_number integer NOT NULL,
        gross_score integer NOT NULL,
        stableford_points integer,
        owner_user_id integer,
        version integer DEFAULT 1 NOT NULL,
        op_id character varying(255),
        created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE SEQUENCE public.scorecard_holes_id_seq
        AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
    ALTER SEQUENCE public.scorecard_holes_id_seq OWNED BY public.scorecard_holes.id;

    CREATE TABLE public.scorecards (
        id integer NOT NULL,
        tour_id integer CONSTRAINT scorecards_event_id_not_null NOT NULL,
        round_number integer CONSTRAINT scorecards_day_not_null NOT NULL,
        type character varying(255) NOT NULL,
        user_id integer,
        team_id integer,
        status character varying(255) DEFAULT 'draft'::character varying NOT NULL,
        created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE SEQUENCE public.scorecards_id_seq
        AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
    ALTER SEQUENCE public.scorecards_id_seq OWNED BY public.scorecards.id;

    CREATE TABLE public.skins_carry (
        id integer NOT NULL,
        tour_id integer CONSTRAINT skins_carry_event_id_not_null NOT NULL,
        from_round_number integer CONSTRAINT skins_carry_from_day_not_null NOT NULL,
        from_hole integer NOT NULL,
        to_round_number integer,
        to_hole integer,
        carry_amount numeric(10,2) DEFAULT '0'::numeric NOT NULL,
        created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE SEQUENCE public.skins_carry_id_seq
        AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
    ALTER SEQUENCE public.skins_carry_id_seq OWNED BY public.skins_carry.id;

    CREATE TABLE public.skins_holes (
        id integer NOT NULL,
        tour_id integer CONSTRAINT skins_holes_event_id_not_null NOT NULL,
        round_number integer CONSTRAINT skins_holes_day_not_null NOT NULL,
        hole_number integer NOT NULL,
        participant_type character varying(255) NOT NULL,
        winning_participant_id integer,
        winning_gross integer,
        winning_stableford integer,
        base_pot_amount numeric(10,2) DEFAULT '0'::numeric NOT NULL,
        carry_in_amount numeric(10,2) DEFAULT '0'::numeric NOT NULL,
        total_pot_amount numeric(10,2) DEFAULT '0'::numeric NOT NULL,
        status character varying(255) NOT NULL,
        created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE SEQUENCE public.skins_holes_id_seq
        AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
    ALTER SEQUENCE public.skins_holes_id_seq OWNED BY public.skins_holes.id;

    CREATE TABLE public.team_members (
        id integer NOT NULL,
        team_id integer NOT NULL,
        user_id integer NOT NULL,
        is_dual_assigned boolean DEFAULT false NOT NULL,
        created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE SEQUENCE public.team_members_id_seq
        AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
    ALTER SEQUENCE public.team_members_id_seq OWNED BY public.team_members.id;

    CREATE TABLE public.teams (
        id integer NOT NULL,
        tour_id integer CONSTRAINT teams_event_id_not_null NOT NULL,
        round_number integer CONSTRAINT teams_day_not_null NOT NULL,
        competition_type character varying(255) NOT NULL,
        name character varying(255) NOT NULL,
        ambrose_group_id integer,
        created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE SEQUENCE public.teams_id_seq
        AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
    ALTER SEQUENCE public.teams_id_seq OWNED BY public.teams.id;

    CREATE TABLE public.tee_group_players (
        id integer NOT NULL,
        tee_group_id integer NOT NULL,
        user_id integer NOT NULL,
        "position" integer NOT NULL,
        created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE SEQUENCE public.tee_group_players_id_seq
        AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
    ALTER SEQUENCE public.tee_group_players_id_seq OWNED BY public.tee_group_players.id;

    CREATE TABLE public.tee_groups (
        id integer NOT NULL,
        tour_id integer CONSTRAINT tee_groups_event_id_not_null NOT NULL,
        round_number integer CONSTRAINT tee_groups_day_not_null NOT NULL,
        tee_time time without time zone NOT NULL,
        tee_location character varying(255),
        starting_hole integer DEFAULT 1 NOT NULL,
        group_number integer NOT NULL,
        source character varying(255) DEFAULT 'manual'::character varying NOT NULL,
        created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE SEQUENCE public.tee_groups_id_seq
        AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
    ALTER SEQUENCE public.tee_groups_id_seq OWNED BY public.tee_groups.id;

    CREATE TABLE public.tenant_memberships (
        id integer NOT NULL,
        tenant_id integer NOT NULL,
        user_id integer NOT NULL,
        role character varying(255) DEFAULT 'player'::character varying NOT NULL,
        joined_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
        invited_by_user_id integer,
        created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE SEQUENCE public.tenant_memberships_id_seq
        AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
    ALTER SEQUENCE public.tenant_memberships_id_seq OWNED BY public.tenant_memberships.id;

    CREATE TABLE public.tenants (
        id integer NOT NULL,
        name character varying(255) NOT NULL,
        slug character varying(255) NOT NULL,
        plan character varying(255) DEFAULT 'free'::character varying NOT NULL,
        subscription_status character varying(255) DEFAULT 'trialing'::character varying NOT NULL,
        settings jsonb DEFAULT '{}'::jsonb NOT NULL,
        created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE SEQUENCE public.tenants_id_seq
        AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
    ALTER SEQUENCE public.tenants_id_seq OWNED BY public.tenants.id;

    CREATE TABLE public.tour_admins (
        id integer NOT NULL,
        tour_id integer NOT NULL,
        user_id integer NOT NULL,
        created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
    );
    CREATE SEQUENCE public.tour_admins_id_seq
        AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
    ALTER SEQUENCE public.tour_admins_id_seq OWNED BY public.tour_admins.id;

    CREATE TABLE public.users (
        id integer NOT NULL,
        first_name character varying(255) NOT NULL,
        last_name character varying(255) NOT NULL,
        email character varying(255) NOT NULL,
        phone_number character varying(255),
        email_verified_at timestamp with time zone,
        created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
        is_super_admin boolean DEFAULT false NOT NULL,
        gender character varying(10) DEFAULT 'male'::character varying NOT NULL,
        pending_email character varying(255),
        pending_email_nonce character varying(255),
        pending_email_expires_at timestamp with time zone
    );
    CREATE SEQUENCE public.users_id_seq
        AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
    ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;

    CREATE TABLE public.virtual_team_players (
        virtual_team_id integer NOT NULL,
        user_id integer NOT NULL
    );

    CREATE TABLE public.virtual_teams (
        id integer NOT NULL,
        tour_id integer NOT NULL,
        name character varying(100) NOT NULL,
        created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE SEQUENCE public.virtual_teams_id_seq
        AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
    ALTER SEQUENCE public.virtual_teams_id_seq OWNED BY public.virtual_teams.id;

    -- Set sequence defaults
    ALTER TABLE ONLY public.ambrose_drives ALTER COLUMN id SET DEFAULT nextval('public.ambrose_drives_id_seq'::regclass);
    ALTER TABLE ONLY public.ambrose_groups ALTER COLUMN id SET DEFAULT nextval('public.ambrose_groups_id_seq'::regclass);
    ALTER TABLE ONLY public.calcutta_auctions ALTER COLUMN id SET DEFAULT nextval('public.calcutta_auctions_id_seq'::regclass);
    ALTER TABLE ONLY public.courses ALTER COLUMN id SET DEFAULT nextval('public.courses_id_seq'::regclass);
    ALTER TABLE ONLY public.event_players ALTER COLUMN id SET DEFAULT nextval('public.event_players_id_seq'::regclass);
    ALTER TABLE ONLY public.golf_rounds ALTER COLUMN id SET DEFAULT nextval('public.event_day_statuses_id_seq'::regclass);
    ALTER TABLE ONLY public.holes ALTER COLUMN id SET DEFAULT nextval('public.holes_id_seq'::regclass);
    ALTER TABLE ONLY public.invitations ALTER COLUMN id SET DEFAULT nextval('public.invitations_id_seq'::regclass);
    ALTER TABLE ONLY public.itinerary_items ALTER COLUMN id SET DEFAULT nextval('public.itinerary_items_id_seq'::regclass);
    ALTER TABLE ONLY public.leaderboard_snapshots ALTER COLUMN id SET DEFAULT nextval('public.leaderboard_snapshots_id_seq'::regclass);
    ALTER TABLE ONLY public.login_codes ALTER COLUMN id SET DEFAULT nextval('public.login_codes_id_seq'::regclass);
    ALTER TABLE ONLY public.novelty_events ALTER COLUMN id SET DEFAULT nextval('public.novelty_events_id_seq'::regclass);
    ALTER TABLE ONLY public.novelty_results ALTER COLUMN id SET DEFAULT nextval('public.novelty_results_id_seq'::regclass);
    ALTER TABLE ONLY public.player_day_handicaps ALTER COLUMN id SET DEFAULT nextval('public.player_day_handicaps_id_seq'::regclass);
    ALTER TABLE ONLY public.player_handicaps ALTER COLUMN id SET DEFAULT nextval('public.player_handicaps_id_seq'::regclass);
    ALTER TABLE ONLY public.scorecard_edit_logs ALTER COLUMN id SET DEFAULT nextval('public.scorecard_edit_logs_id_seq'::regclass);
    ALTER TABLE ONLY public.scorecard_holes ALTER COLUMN id SET DEFAULT nextval('public.scorecard_holes_id_seq'::regclass);
    ALTER TABLE ONLY public.scorecards ALTER COLUMN id SET DEFAULT nextval('public.scorecards_id_seq'::regclass);
    ALTER TABLE ONLY public.skins_carry ALTER COLUMN id SET DEFAULT nextval('public.skins_carry_id_seq'::regclass);
    ALTER TABLE ONLY public.skins_holes ALTER COLUMN id SET DEFAULT nextval('public.skins_holes_id_seq'::regclass);
    ALTER TABLE ONLY public.team_members ALTER COLUMN id SET DEFAULT nextval('public.team_members_id_seq'::regclass);
    ALTER TABLE ONLY public.teams ALTER COLUMN id SET DEFAULT nextval('public.teams_id_seq'::regclass);
    ALTER TABLE ONLY public.tee_group_players ALTER COLUMN id SET DEFAULT nextval('public.tee_group_players_id_seq'::regclass);
    ALTER TABLE ONLY public.tee_groups ALTER COLUMN id SET DEFAULT nextval('public.tee_groups_id_seq'::regclass);
    ALTER TABLE ONLY public.tenant_memberships ALTER COLUMN id SET DEFAULT nextval('public.tenant_memberships_id_seq'::regclass);
    ALTER TABLE ONLY public.tenants ALTER COLUMN id SET DEFAULT nextval('public.tenants_id_seq'::regclass);
    ALTER TABLE ONLY public.tour_admins ALTER COLUMN id SET DEFAULT nextval('public.tour_admins_id_seq'::regclass);
    ALTER TABLE ONLY public.tours ALTER COLUMN id SET DEFAULT nextval('public.events_id_seq'::regclass);
    ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);
    ALTER TABLE ONLY public.virtual_teams ALTER COLUMN id SET DEFAULT nextval('public.virtual_teams_id_seq'::regclass);

    -- Primary keys and unique constraints
    ALTER TABLE ONLY public.ambrose_drives ADD CONSTRAINT ambrose_drives_pkey PRIMARY KEY (id);
    ALTER TABLE ONLY public.ambrose_drives ADD CONSTRAINT ambrose_drives_scorecard_id_hole_number_unique UNIQUE (scorecard_id, hole_number);
    ALTER TABLE ONLY public.ambrose_groups ADD CONSTRAINT ambrose_groups_event_id_day_group_number_unique UNIQUE (tour_id, round_number, group_number);
    ALTER TABLE ONLY public.ambrose_groups ADD CONSTRAINT ambrose_groups_pkey PRIMARY KEY (id);
    ALTER TABLE ONLY public.calcutta_auctions ADD CONSTRAINT calcutta_auctions_event_id_auctioned_user_id_unique UNIQUE (tour_id, auctioned_user_id);
    ALTER TABLE ONLY public.calcutta_auctions ADD CONSTRAINT calcutta_auctions_event_id_draw_order_unique UNIQUE (tour_id, draw_order);
    ALTER TABLE ONLY public.calcutta_auctions ADD CONSTRAINT calcutta_auctions_pkey PRIMARY KEY (id);
    ALTER TABLE ONLY public.courses ADD CONSTRAINT courses_pkey PRIMARY KEY (id);
    ALTER TABLE ONLY public.courses ADD CONSTRAINT courses_tenant_id_course_name_tee_name_unique UNIQUE (tenant_id, course_name, tee_name);
    ALTER TABLE ONLY public.golf_rounds ADD CONSTRAINT event_day_statuses_event_id_day_unique UNIQUE (tour_id, round_number);
    ALTER TABLE ONLY public.golf_rounds ADD CONSTRAINT event_day_statuses_pkey PRIMARY KEY (id);
    ALTER TABLE ONLY public.event_players ADD CONSTRAINT event_players_event_id_user_id_unique UNIQUE (tour_id, user_id);
    ALTER TABLE ONLY public.event_players ADD CONSTRAINT event_players_pkey PRIMARY KEY (id);
    ALTER TABLE ONLY public.tours ADD CONSTRAINT events_pkey PRIMARY KEY (id);
    ALTER TABLE ONLY public.holes ADD CONSTRAINT holes_course_id_hole_number_unique UNIQUE (course_id, hole_number);
    ALTER TABLE ONLY public.holes ADD CONSTRAINT holes_pkey PRIMARY KEY (id);
    ALTER TABLE ONLY public.invitations ADD CONSTRAINT invitations_pkey PRIMARY KEY (id);
    ALTER TABLE ONLY public.invitations ADD CONSTRAINT invitations_token_hash_unique UNIQUE (token_hash);
    ALTER TABLE ONLY public.itinerary_items ADD CONSTRAINT itinerary_items_pkey PRIMARY KEY (id);
    ALTER TABLE ONLY public.leaderboard_snapshots ADD CONSTRAINT leaderboard_snapshots_pkey PRIMARY KEY (id);
    ALTER TABLE ONLY public.login_codes ADD CONSTRAINT login_codes_pkey PRIMARY KEY (id);
    ALTER TABLE ONLY public.novelty_events ADD CONSTRAINT novelty_events_pkey PRIMARY KEY (id);
    ALTER TABLE ONLY public.novelty_results ADD CONSTRAINT novelty_results_novelty_event_id_unique UNIQUE (novelty_event_id);
    ALTER TABLE ONLY public.novelty_results ADD CONSTRAINT novelty_results_pkey PRIMARY KEY (id);
    ALTER TABLE ONLY public.player_day_handicaps ADD CONSTRAINT player_day_handicaps_event_id_user_id_day_unique UNIQUE (tour_id, user_id, round_number);
    ALTER TABLE ONLY public.player_day_handicaps ADD CONSTRAINT player_day_handicaps_pkey PRIMARY KEY (id);
    ALTER TABLE ONLY public.player_handicaps ADD CONSTRAINT player_handicaps_event_id_user_id_unique UNIQUE (tour_id, user_id);
    ALTER TABLE ONLY public.player_handicaps ADD CONSTRAINT player_handicaps_pkey PRIMARY KEY (id);
    ALTER TABLE ONLY public.scorecard_edit_logs ADD CONSTRAINT scorecard_edit_logs_pkey PRIMARY KEY (id);
    ALTER TABLE ONLY public.scorecard_holes ADD CONSTRAINT scorecard_holes_op_id_unique UNIQUE (op_id);
    ALTER TABLE ONLY public.scorecard_holes ADD CONSTRAINT scorecard_holes_pkey PRIMARY KEY (id);
    ALTER TABLE ONLY public.scorecard_holes ADD CONSTRAINT scorecard_holes_scorecard_id_hole_number_unique UNIQUE (scorecard_id, hole_number);
    ALTER TABLE ONLY public.scorecards ADD CONSTRAINT scorecards_pkey PRIMARY KEY (id);
    ALTER TABLE ONLY public.skins_carry ADD CONSTRAINT skins_carry_pkey PRIMARY KEY (id);
    ALTER TABLE ONLY public.skins_holes ADD CONSTRAINT skins_holes_event_id_day_hole_number_participant_type_unique UNIQUE (tour_id, round_number, hole_number, participant_type);
    ALTER TABLE ONLY public.skins_holes ADD CONSTRAINT skins_holes_pkey PRIMARY KEY (id);
    ALTER TABLE ONLY public.team_members ADD CONSTRAINT team_members_pkey PRIMARY KEY (id);
    ALTER TABLE ONLY public.team_members ADD CONSTRAINT team_members_team_id_user_id_unique UNIQUE (team_id, user_id);
    ALTER TABLE ONLY public.teams ADD CONSTRAINT teams_pkey PRIMARY KEY (id);
    ALTER TABLE ONLY public.tee_group_players ADD CONSTRAINT tee_group_players_pkey PRIMARY KEY (id);
    ALTER TABLE ONLY public.tee_group_players ADD CONSTRAINT tee_group_players_tee_group_id_user_id_unique UNIQUE (tee_group_id, user_id);
    ALTER TABLE ONLY public.tee_groups ADD CONSTRAINT tee_groups_pkey PRIMARY KEY (id);
    ALTER TABLE ONLY public.tenant_memberships ADD CONSTRAINT tenant_memberships_pkey PRIMARY KEY (id);
    ALTER TABLE ONLY public.tenant_memberships ADD CONSTRAINT tenant_memberships_tenant_id_user_id_unique UNIQUE (tenant_id, user_id);
    ALTER TABLE ONLY public.tenants ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);
    ALTER TABLE ONLY public.tenants ADD CONSTRAINT tenants_slug_unique UNIQUE (slug);
    ALTER TABLE ONLY public.tour_admins ADD CONSTRAINT tour_admins_pkey PRIMARY KEY (id);
    ALTER TABLE ONLY public.tour_admins ADD CONSTRAINT tour_admins_tour_id_user_id_unique UNIQUE (tour_id, user_id);
    ALTER TABLE ONLY public.users ADD CONSTRAINT users_email_unique UNIQUE (email);
    ALTER TABLE ONLY public.users ADD CONSTRAINT users_pkey PRIMARY KEY (id);
    ALTER TABLE ONLY public.virtual_team_players ADD CONSTRAINT virtual_team_players_pkey PRIMARY KEY (virtual_team_id, user_id);
    ALTER TABLE ONLY public.virtual_teams ADD CONSTRAINT virtual_teams_pkey PRIMARY KEY (id);

    -- Indexes
    CREATE INDEX idx_events_tenant ON public.tours USING btree (tenant_id);
    CREATE INDEX idx_invitations_tenant_email ON public.invitations USING btree (tenant_id, email);
    CREATE INDEX idx_leaderboard_snapshots_event_day ON public.leaderboard_snapshots USING btree (tour_id, round_number);
    CREATE INDEX idx_login_codes_user_created ON public.login_codes USING btree (user_id, created_at DESC);
    CREATE INDEX idx_novelty_events_event_day ON public.novelty_events USING btree (tour_id, round_number);
    CREATE INDEX idx_novelty_results_event_day ON public.novelty_results USING btree (tour_id, round_number);
    CREATE INDEX idx_scorecard_edit_logs_scorecard_created ON public.scorecard_edit_logs USING btree (scorecard_id, created_at);
    CREATE INDEX idx_tenant_memberships_user ON public.tenant_memberships USING btree (user_id);
    CREATE UNIQUE INDEX ux_courses_api_key ON public.courses USING btree (tenant_id, api_course_id, api_tee_key) WHERE ((api_course_id IS NOT NULL) AND (api_tee_key IS NOT NULL));
    CREATE UNIQUE INDEX ux_scorecards_individual ON public.scorecards USING btree (tour_id, round_number, user_id) WHERE (((type)::text = 'individual'::text) AND (user_id IS NOT NULL));
    CREATE UNIQUE INDEX ux_scorecards_team ON public.scorecards USING btree (tour_id, round_number, team_id) WHERE (((type)::text = 'team'::text) AND (team_id IS NOT NULL));
    CREATE UNIQUE INDEX ux_teams_ambrose_name_in_group ON public.teams USING btree (tour_id, round_number, competition_type, ambrose_group_id, name) WHERE (((competition_type)::text = 'ambrose'::text) AND (ambrose_group_id IS NOT NULL));
    CREATE UNIQUE INDEX ux_users_phone_number ON public.users USING btree (phone_number) WHERE ((phone_number IS NOT NULL) AND ((phone_number)::text <> ''::text));

    -- Foreign keys
    ALTER TABLE ONLY public.ambrose_drives ADD CONSTRAINT ambrose_drives_drive_taken_user_id_foreign FOREIGN KEY (drive_taken_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.ambrose_drives ADD CONSTRAINT ambrose_drives_scorecard_id_foreign FOREIGN KEY (scorecard_id) REFERENCES public.scorecards(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.ambrose_groups ADD CONSTRAINT ambrose_groups_event_id_foreign FOREIGN KEY (tour_id) REFERENCES public.tours(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.calcutta_auctions ADD CONSTRAINT calcutta_auctions_auctioned_user_id_foreign FOREIGN KEY (auctioned_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.calcutta_auctions ADD CONSTRAINT calcutta_auctions_buyer_user_id_foreign FOREIGN KEY (buyer_user_id) REFERENCES public.users(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.calcutta_auctions ADD CONSTRAINT calcutta_auctions_event_id_foreign FOREIGN KEY (tour_id) REFERENCES public.tours(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.calcutta_auctions ADD CONSTRAINT calcutta_auctions_owner_user_id_foreign FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
    ALTER TABLE ONLY public.courses ADD CONSTRAINT courses_tenant_id_foreign FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.golf_rounds ADD CONSTRAINT event_day_statuses_course_id_foreign FOREIGN KEY (course_id) REFERENCES public.courses(id);
    ALTER TABLE ONLY public.golf_rounds ADD CONSTRAINT event_day_statuses_event_id_foreign FOREIGN KEY (tour_id) REFERENCES public.tours(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.event_players ADD CONSTRAINT event_players_event_id_foreign FOREIGN KEY (tour_id) REFERENCES public.tours(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.event_players ADD CONSTRAINT event_players_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.tours ADD CONSTRAINT events_tenant_id_foreign FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.golf_rounds ADD CONSTRAINT golf_rounds_female_course_id_foreign FOREIGN KEY (female_course_id) REFERENCES public.courses(id) ON DELETE SET NULL;
    ALTER TABLE ONLY public.holes ADD CONSTRAINT holes_course_id_foreign FOREIGN KEY (course_id) REFERENCES public.courses(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.invitations ADD CONSTRAINT invitations_invited_by_user_id_foreign FOREIGN KEY (invited_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
    ALTER TABLE ONLY public.invitations ADD CONSTRAINT invitations_tenant_id_foreign FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.itinerary_items ADD CONSTRAINT itinerary_items_tour_id_foreign FOREIGN KEY (tour_id) REFERENCES public.tours(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.itinerary_items ADD CONSTRAINT itinerary_items_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.leaderboard_snapshots ADD CONSTRAINT leaderboard_snapshots_event_id_foreign FOREIGN KEY (tour_id) REFERENCES public.tours(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.login_codes ADD CONSTRAINT login_codes_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.novelty_events ADD CONSTRAINT novelty_events_course_id_foreign FOREIGN KEY (course_id) REFERENCES public.courses(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.novelty_events ADD CONSTRAINT novelty_events_event_id_foreign FOREIGN KEY (tour_id) REFERENCES public.tours(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.novelty_results ADD CONSTRAINT novelty_results_event_id_foreign FOREIGN KEY (tour_id) REFERENCES public.tours(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.novelty_results ADD CONSTRAINT novelty_results_novelty_event_id_foreign FOREIGN KEY (novelty_event_id) REFERENCES public.novelty_events(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.novelty_results ADD CONSTRAINT novelty_results_winner_team_id_foreign FOREIGN KEY (winner_team_id) REFERENCES public.teams(id) ON DELETE SET NULL;
    ALTER TABLE ONLY public.novelty_results ADD CONSTRAINT novelty_results_winner_user_id_foreign FOREIGN KEY (winner_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
    ALTER TABLE ONLY public.player_day_handicaps ADD CONSTRAINT player_day_handicaps_event_id_foreign FOREIGN KEY (tour_id) REFERENCES public.tours(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.player_day_handicaps ADD CONSTRAINT player_day_handicaps_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.player_handicaps ADD CONSTRAINT player_handicaps_event_id_foreign FOREIGN KEY (tour_id) REFERENCES public.tours(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.player_handicaps ADD CONSTRAINT player_handicaps_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.scorecard_edit_logs ADD CONSTRAINT scorecard_edit_logs_editor_user_id_foreign FOREIGN KEY (editor_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
    ALTER TABLE ONLY public.scorecard_edit_logs ADD CONSTRAINT scorecard_edit_logs_scorecard_id_foreign FOREIGN KEY (scorecard_id) REFERENCES public.scorecards(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.scorecard_holes ADD CONSTRAINT scorecard_holes_owner_user_id_foreign FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
    ALTER TABLE ONLY public.scorecard_holes ADD CONSTRAINT scorecard_holes_scorecard_id_foreign FOREIGN KEY (scorecard_id) REFERENCES public.scorecards(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.scorecards ADD CONSTRAINT scorecards_event_id_foreign FOREIGN KEY (tour_id) REFERENCES public.tours(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.scorecards ADD CONSTRAINT scorecards_team_id_foreign FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.scorecards ADD CONSTRAINT scorecards_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.skins_carry ADD CONSTRAINT skins_carry_event_id_foreign FOREIGN KEY (tour_id) REFERENCES public.tours(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.skins_holes ADD CONSTRAINT skins_holes_event_id_foreign FOREIGN KEY (tour_id) REFERENCES public.tours(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.team_members ADD CONSTRAINT team_members_team_id_foreign FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.team_members ADD CONSTRAINT team_members_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.teams ADD CONSTRAINT teams_ambrose_group_id_foreign FOREIGN KEY (ambrose_group_id) REFERENCES public.ambrose_groups(id) ON DELETE SET NULL;
    ALTER TABLE ONLY public.teams ADD CONSTRAINT teams_event_id_foreign FOREIGN KEY (tour_id) REFERENCES public.tours(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.tee_group_players ADD CONSTRAINT tee_group_players_tee_group_id_foreign FOREIGN KEY (tee_group_id) REFERENCES public.tee_groups(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.tee_group_players ADD CONSTRAINT tee_group_players_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.tee_groups ADD CONSTRAINT tee_groups_event_id_foreign FOREIGN KEY (tour_id) REFERENCES public.tours(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.tenant_memberships ADD CONSTRAINT tenant_memberships_invited_by_user_id_foreign FOREIGN KEY (invited_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
    ALTER TABLE ONLY public.tenant_memberships ADD CONSTRAINT tenant_memberships_tenant_id_foreign FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.tenant_memberships ADD CONSTRAINT tenant_memberships_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.tour_admins ADD CONSTRAINT tour_admins_tour_id_foreign FOREIGN KEY (tour_id) REFERENCES public.tours(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.tour_admins ADD CONSTRAINT tour_admins_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.virtual_team_players ADD CONSTRAINT virtual_team_players_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.virtual_team_players ADD CONSTRAINT virtual_team_players_virtual_team_id_foreign FOREIGN KEY (virtual_team_id) REFERENCES public.virtual_teams(id) ON DELETE CASCADE;
    ALTER TABLE ONLY public.virtual_teams ADD CONSTRAINT virtual_teams_tour_id_foreign FOREIGN KEY (tour_id) REFERENCES public.tours(id) ON DELETE CASCADE;
  `);
};

exports.down = async () => {
  throw new Error('Initial schema migration cannot be rolled back — drop and recreate the database instead');
};
