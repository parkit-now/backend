-- La constancia del punto de venta (PDF) deja de pedirse al vincular ARCA:
-- el punto de venta ya se valida contra ARCA (FEParamGetPtosVenta sólo lista
-- los de web services, se rechazan los bloqueados o dados de baja, y
-- FECompUltimoAutorizado tiene que responder), que prueba más que un archivo
-- que nadie lee. La columna nunca llegó a usarse en producción.
ALTER TABLE arca_accounts DROP COLUMN pto_vta_constancia_path;
