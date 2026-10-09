CREATE TABLE collection_websites (
  collection_id uuid NOT NULL,
  client_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT collection_websites_collection_id_client_id_pk PRIMARY KEY (collection_id, client_id),
  CONSTRAINT collection_websites_collection_id_collections_id_fk
    FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
  CONSTRAINT collection_websites_client_id_api_clients_id_fk
    FOREIGN KEY (client_id) REFERENCES api_clients(id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX collection_websites_client_idx
  ON collection_websites(client_id);