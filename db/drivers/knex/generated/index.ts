/** Load Dependency Source Graphs */

import '@brentbahry/reflection';
import '@brentbahry/util';
import '@proteinjs/db';
import '@proteinjs/db-query';
import 'knex';
import 'moment';
import 'mysql';
import 'uuid';


/** Generate Source Graph */

const sourceGraph = "{\"options\":{\"directed\":true,\"multigraph\":false,\"compound\":false},\"nodes\":[{\"v\":\"@proteinjs/db-driver-knex/KnexConfig\",\"value\":{\"packageName\":\"@proteinjs/db-driver-knex\",\"name\":\"KnexConfig\",\"filePath\":\"/Users/brentbahry/repos/components/db/drivers/knex/src/KnexConfig.ts\",\"qualifiedName\":\"@proteinjs/db-driver-knex/KnexConfig\",\"typeParameters\":[],\"directParents\":[{\"packageName\":\"@brentbahry/reflection\",\"name\":\"Loadable\",\"filePath\":null,\"qualifiedName\":\"@brentbahry/reflection/Loadable\",\"typeParameters\":[],\"directParents\":null},{\"packageName\":\"@proteinjs/db-driver-knex\",\"name\":\"{\\n  host?: string,\\n  user?: string,\\n  password?: string,\\n  dbName?: string,\\n}\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/db-driver-knex/{\\n  host?: string,\\n  user?: string,\\n  password?: string,\\n  dbName?: string,\\n}\",\"typeParameters\":[],\"directParents\":null}],\"sourceType\":1}},{\"v\":\"@brentbahry/reflection/Loadable\"},{\"v\":\"@proteinjs/db-driver-knex/KnexDriver\",\"value\":{\"packageName\":\"@proteinjs/db-driver-knex\",\"name\":\"KnexDriver\",\"filePath\":\"/Users/brentbahry/repos/components/db/drivers/knex/src/KnexDriver.ts\",\"qualifiedName\":\"@proteinjs/db-driver-knex/KnexDriver\",\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"properties\":[{\"name\":\"KNEX\",\"type\":{\"packageName\":\"\",\"name\":\"knex\",\"filePath\":null,\"qualifiedName\":\"/knex\",\"typeParameters\":null,\"directParents\":null},\"isOptional\":false,\"isAbstract\":false,\"isStatic\":true,\"visibility\":\"private\"},{\"name\":\"logger\",\"type\":null,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"private\"},{\"name\":\"config\",\"type\":{\"packageName\":\"@proteinjs/db-driver-knex\",\"name\":\"KnexConfig\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/db-driver-knex/KnexConfig\",\"typeParameters\":null,\"directParents\":null},\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"private\"},{\"name\":\"knexConfig\",\"type\":{\"packageName\":\"\",\"name\":\"any\",\"filePath\":null,\"qualifiedName\":\"/any\",\"typeParameters\":null,\"directParents\":null},\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"private\"}],\"methods\":[{\"name\":\"getKnex\",\"returnType\":{\"packageName\":\"\",\"name\":\"knex\",\"filePath\":null,\"qualifiedName\":\"/knex\",\"typeParameters\":null,\"directParents\":null},\"isAsync\":false,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[]},{\"name\":\"getDbName\",\"returnType\":null,\"isAsync\":false,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[]},{\"name\":\"createDbIfNotExists\",\"returnType\":{\"packageName\":\"\",\"name\":\"Promise<void>\",\"filePath\":null,\"qualifiedName\":\"/Promise<void>\",\"typeParameters\":null,\"directParents\":null},\"isAsync\":true,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[]},{\"name\":\"dbExists\",\"returnType\":{\"packageName\":\"\",\"name\":\"Promise<boolean>\",\"filePath\":null,\"qualifiedName\":\"/Promise<boolean>\",\"typeParameters\":null,\"directParents\":null},\"isAsync\":true,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"private\",\"parameters\":[{\"name\":\"databaseName\",\"type\":{\"packageName\":\"\",\"name\":\"string\",\"filePath\":null,\"qualifiedName\":\"/string\",\"typeParameters\":null,\"directParents\":null}}]},{\"name\":\"start\",\"returnType\":null,\"isAsync\":true,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[]},{\"name\":\"stop\",\"returnType\":null,\"isAsync\":true,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[]},{\"name\":\"setMaxAllowedPacketSize\",\"returnType\":{\"packageName\":\"\",\"name\":\"Promise<void>\",\"filePath\":null,\"qualifiedName\":\"/Promise<void>\",\"typeParameters\":null,\"directParents\":null},\"isAsync\":true,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"private\",\"parameters\":[]},{\"name\":\"getTableManager\",\"returnType\":{\"packageName\":\"@proteinjs/db\",\"name\":\"TableManager\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/db/TableManager\",\"typeParameters\":null,\"directParents\":null},\"isAsync\":false,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[]},{\"name\":\"runQuery\",\"returnType\":{\"packageName\":\"\",\"name\":\"Promise<SerializedRecord[]>\",\"filePath\":null,\"qualifiedName\":\"/Promise<SerializedRecord[]>\",\"typeParameters\":null,\"directParents\":null},\"isAsync\":true,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[{\"name\":\"generateStatement\",\"type\":{\"packageName\":\"\",\"name\":\"(config: DbDriverStatementConfig) => Statement\",\"filePath\":null,\"qualifiedName\":\"/(config: DbDriverStatementConfig) => Statement\",\"typeParameters\":null,\"directParents\":null}}]},{\"name\":\"runDml\",\"returnType\":{\"packageName\":\"\",\"name\":\"Promise<number>\",\"filePath\":null,\"qualifiedName\":\"/Promise<number>\",\"typeParameters\":null,\"directParents\":null},\"isAsync\":true,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[{\"name\":\"generateStatement\",\"type\":{\"packageName\":\"\",\"name\":\"(config: DbDriverStatementConfig) => Statement\",\"filePath\":null,\"qualifiedName\":\"/(config: DbDriverStatementConfig) => Statement\",\"typeParameters\":null,\"directParents\":null}}]}],\"typeParameters\":[],\"directParentInterfaces\":[{\"packageName\":\"@proteinjs/db\",\"name\":\"DbDriver\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/db/DbDriver\",\"properties\":[],\"methods\":[],\"typeParameters\":[],\"directParents\":[]}],\"directParentClasses\":[],\"sourceType\":2}},{\"v\":\"@proteinjs/db/DbDriver\"},{\"v\":\"@proteinjs/db-driver-knex/KnexSchemaOperations\",\"value\":{\"packageName\":\"@proteinjs/db-driver-knex\",\"name\":\"KnexSchemaOperations\",\"filePath\":\"/Users/brentbahry/repos/components/db/drivers/knex/src/KnexSchemaOperations.ts\",\"qualifiedName\":\"@proteinjs/db-driver-knex/KnexSchemaOperations\",\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"properties\":[{\"name\":\"logger\",\"type\":null,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"private\"},{\"name\":\"knexDriver\",\"type\":{\"packageName\":\"@proteinjs/db-driver-knex\",\"name\":\"KnexDriver\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/db-driver-knex/KnexDriver\",\"typeParameters\":null,\"directParents\":null},\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"private\"}],\"methods\":[{\"name\":\"createTable\",\"returnType\":null,\"isAsync\":true,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[{\"name\":\"table\",\"type\":{\"packageName\":\"\",\"name\":\"Table<any>\",\"filePath\":null,\"qualifiedName\":\"/Table<any>\",\"typeParameters\":null,\"directParents\":null}}]},{\"name\":\"alterTable\",\"returnType\":null,\"isAsync\":true,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"parameters\":[{\"name\":\"table\",\"type\":{\"packageName\":\"\",\"name\":\"Table<any>\",\"filePath\":null,\"qualifiedName\":\"/Table<any>\",\"typeParameters\":null,\"directParents\":null}},{\"name\":\"tableChanges\",\"type\":{\"packageName\":\"@proteinjs/db\",\"name\":\"TableChanges\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/db/TableChanges\",\"typeParameters\":null,\"directParents\":null}}]},{\"name\":\"createColumn\",\"returnType\":null,\"isAsync\":false,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"private\",\"parameters\":[{\"name\":\"column\",\"type\":{\"packageName\":\"\",\"name\":\"Column<any, any>\",\"filePath\":null,\"qualifiedName\":\"/Column<any, any>\",\"typeParameters\":null,\"directParents\":null}},{\"name\":\"table\",\"type\":{\"packageName\":\"\",\"name\":\"Table<any>\",\"filePath\":null,\"qualifiedName\":\"/Table<any>\",\"typeParameters\":null,\"directParents\":null}},{\"name\":\"tableBuilder\",\"type\":{\"packageName\":\"\",\"name\":\"knex.TableBuilder\",\"filePath\":null,\"qualifiedName\":\"/knex.TableBuilder\",\"typeParameters\":null,\"directParents\":null}},{\"name\":\"tableChanges\",\"type\":{\"packageName\":\"@proteinjs/db\",\"name\":\"TableChanges\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/db/TableChanges\",\"typeParameters\":null,\"directParents\":null}}]}],\"typeParameters\":[],\"directParentInterfaces\":[{\"packageName\":\"@proteinjs/db\",\"name\":\"SchemaOperations\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/db/SchemaOperations\",\"properties\":[],\"methods\":[],\"typeParameters\":[],\"directParents\":[]}],\"directParentClasses\":[],\"sourceType\":2}},{\"v\":\"@proteinjs/db/SchemaOperations\"}],\"edges\":[{\"v\":\"@proteinjs/db-driver-knex/KnexConfig\",\"w\":\"@brentbahry/reflection/Loadable\",\"value\":\"extends type\"},{\"v\":\"@proteinjs/db-driver-knex/KnexDriver\",\"w\":\"@proteinjs/db/DbDriver\",\"value\":\"implements interface\"},{\"v\":\"@proteinjs/db-driver-knex/KnexSchemaOperations\",\"w\":\"@proteinjs/db/SchemaOperations\",\"value\":\"implements interface\"}]}";


/** Generate Source Links */

import { KnexDriver } from '../src/KnexDriver';
import { KnexSchemaOperations } from '../src/KnexSchemaOperations';

const sourceLinks = {
	'@proteinjs/db-driver-knex/KnexDriver': KnexDriver,
	'@proteinjs/db-driver-knex/KnexSchemaOperations': KnexSchemaOperations,
};


/** Load Source Graph and Links */

import { SourceRepository } from '@brentbahry/reflection';
SourceRepository.merge(sourceGraph, sourceLinks);


export * from '../index';