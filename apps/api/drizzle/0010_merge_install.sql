-- Un comando de build y uno de inicio, como Workers: la instalación pasa a ser parte del build.
UPDATE `apps` SET `build_command` = CASE
  WHEN trim(`install_command`) = '' THEN `build_command`
  WHEN trim(`build_command`) = '' THEN `install_command`
  ELSE `install_command` || ' && ' || `build_command`
END;--> statement-breakpoint
ALTER TABLE `apps` DROP COLUMN `install_command`;
