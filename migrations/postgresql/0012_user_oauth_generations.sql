create table if not exists user_oauth_generations (
  service text not null,
  connection_name text not null,
  generation text not null,
  primary key (service, connection_name)
);
